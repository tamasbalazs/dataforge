/**
 * Two-way binding between a Monaco text model and a Y.Text, plus remote
 * cursors/selections drawn as decorations with the peer's name.
 */
import * as Y from 'yjs';
import { readableText } from './protocol';
import type * as M from '../panels/editor/monaco';

/**
 * Keep `model` and `ytext` equal. The Y.Text wins at bind time (it carries
 * edits of everyone in the session). Local edits are applied to the Y.Text
 * with `origin`; remote Y.Text changes are applied to the model.
 */
export function bindModel(ytext: Y.Text, model: M.editor.ITextModel, origin: unknown): () => void {
  const doc = ytext.doc!;
  // Offsets must mean the same on both sides.
  if (model.getEOL() !== '\n') model.setEOL(0 /* EndOfLineSequence.LF */);
  let remote = false;
  const current = ytext.toString();
  if (model.getValue() !== current) {
    remote = true;
    try {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: current }], () => null);
    } finally {
      remote = false;
    }
  }

  const onY = (event: Y.YTextEvent, tr: Y.Transaction) => {
    if (tr.origin === origin || model.isDisposed()) return;
    remote = true;
    try {
      let index = 0;
      for (const op of event.delta) {
        if (op.retain !== undefined) index += op.retain;
        else if (op.insert !== undefined) {
          const text = typeof op.insert === 'string' ? op.insert : '';
          const pos = model.getPositionAt(index);
          model.applyEdits([{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text }]);
          index += text.length;
        } else if (op.delete !== undefined) {
          const a = model.getPositionAt(index);
          const b = model.getPositionAt(index + op.delete);
          model.applyEdits([{ range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }, text: '' }]);
        }
      }
    } finally {
      remote = false;
    }
  };
  ytext.observe(onY);

  const sub = model.onDidChangeContent((e) => {
    if (remote) return;
    doc.transact(() => {
      // Apply from the end so earlier offsets stay valid.
      for (const c of [...e.changes].sort((x, y) => y.rangeOffset - x.rangeOffset)) {
        if (c.rangeLength) ytext.delete(c.rangeOffset, c.rangeLength);
        if (c.text) ytext.insert(c.rangeOffset, c.text);
      }
    }, origin);
  });

  return () => {
    ytext.unobserve(onY);
    sub.dispose();
  };
}

// --- Remote cursors ----------------------------------------------------------

export interface RemoteCaret {
  id: string;
  name: string;
  color: string;
  anchor: unknown | null;
  head: unknown | null;
}

const styled = new Map<string, string>();
let sheet: HTMLStyleElement | null = null;

/** One CSS class per peer (colour + name label); rewritten when either changes. */
export function peerClass(id: string, name: string, color: string): string {
  const cls = `df-peer-${id.replace(/[^a-z0-9_-]/gi, '')}`;
  const key = `${name}\u0000${color}`;
  if (styled.get(cls) !== key) {
    styled.set(cls, key);
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.dataset.collab = '';
      document.head.appendChild(sheet);
    }
    const rules = [...styled.entries()].map(([c, k]) => {
      const [n, col] = k.split('\u0000');
      return (
        `.${c}-sel{background:${col}33;}` +
        `.${c}-caret{border-left:2px solid ${col};margin-left:-1px;}` +
        `.${c}-caret::after{content:${JSON.stringify(n)};background:${col};color:${readableText(col)};}`
      );
    });
    sheet.textContent = rules.join('\n');
  }
  return cls;
}

/** Absolute offset of a Y.RelativePosition JSON in `doc`, or null. */
export function absoluteOffset(json: unknown, doc: Y.Doc): number | null {
  if (!json) return null;
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
    return abs ? abs.index : null;
  } catch {
    return null;
  }
}

export function relativeJSON(ytext: Y.Text, offset: number): unknown {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, offset));
}

/** Decorations for the carets/selections of `carets` on `model`. */
export function caretDecorations(model: M.editor.ITextModel, doc: Y.Doc, carets: RemoteCaret[]): M.editor.IModelDeltaDecoration[] {
  const out: M.editor.IModelDeltaDecoration[] = [];
  for (const c of carets) {
    const head = absoluteOffset(c.head, doc);
    if (head == null) continue;
    const anchor = absoluteOffset(c.anchor, doc) ?? head;
    const cls = peerClass(c.id, c.name, c.color);
    const h = model.getPositionAt(head);
    if (anchor !== head) {
      const a = model.getPositionAt(Math.min(anchor, head));
      const b = model.getPositionAt(Math.max(anchor, head));
      out.push({
        range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column },
        options: { className: `${cls}-sel`, stickiness: 1 },
      });
    }
    out.push({
      range: { startLineNumber: h.lineNumber, startColumn: h.column, endLineNumber: h.lineNumber, endColumn: h.column },
      options: { beforeContentClassName: `df-peer-caret ${cls}-caret`, hoverMessage: { value: c.name }, stickiness: 1 },
    });
  }
  return out;
}
