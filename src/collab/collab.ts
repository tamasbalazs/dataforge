/**
 * Real-time collaboration, wired into the app.
 *
 * Host: runs the relay (Rust), owns a HostSession, shares its project files as
 * Y.Docs bound to its own editor models, forwards kernel output, and answers
 * guests' requests within their role.
 *
 * Guest: opens the host's project as `collab://<sid>` and routes kernel calls
 * and file access through the session (core/hostRouter), so its console,
 * Environment panel, data viewer, plots and Files panel show the host's
 * workspace; documents are edited together through Y.Text bindings.
 */
import type * as Y from 'yjs';
import { on } from '../core/bus';
import { host, type FsEntry, type KernelStarted, type Lang, type ProjectInfo } from '../core/host';
import { emitGuestFsChanged, emitGuestKernelEvent, setGuestRouting, type GuestRouting } from '../core/hostRouter';
import { t } from '../core/i18n';
import { formatCollab, isCollabPath, joinRelative, parseCollab, relativeTo } from '../core/paths';
import { getSettings, useSettings } from '../core/settings';
import { toast } from '../core/toast';
import {
  callHelper,
  chooseInterpreter,
  execute,
  interruptKernel,
  isRunning,
  LANGS,
  setWorkspaceKernels,
  startKernel,
  trackExternalExecution,
  useKernels,
} from '../kernels/kernels';
import { currentEditor, markSaved, modelForPath, onModelCreated, onModelDisposed, openAt, openFile, saveByPath } from '../panels/editor/editorService';
import { activeDoc, useEditor } from '../panels/editor/editorStore';
import type * as M from '../panels/editor/monaco';
import { bindModel, caretDecorations, relativeJSON, type RemoteCaret } from './binding';
import { useCollab, useCollabPrefs } from './collabStore';
import { cleanName, formatInvitation, mayCall, parseInvitation, toBase64, type Presence, type Role } from './protocol';
import { GuestSession, HostSession, TEXT_KEY, type GuestAdapter, type HostAdapter } from './session';

const HOST_CONN = 'collab-host';
const GUEST_CONN = 'collab-guest';
const LOCAL = { local: true }; // Y transaction origin of this user's own edits

let hostSession: HostSession | null = null;
let guestSession: GuestSession | null = null;
let hostRoot: string | null = null;
let previousWorkdir: string | null = null;
const cleanups: Array<() => void> = [];
const bindings = new Map<M.editor.ITextModel, () => void>();
/** Host: which guest asked for an execution (they already show it). */
const execOrigin = new Map<string, string>();

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error:\s*/, '');

// ---------------------------------------------------------------------------
// State for the UI

function sync() {
  if (hostSession) {
    const s = hostSession;
    useCollab.setState((st) => ({
      me: s.me,
      peers: [...s.peers.values()].filter((p) => p.ready).map(({ ready: _r, ...p }) => p),
      presence: { ...s.presence },
      chat: s.chat,
      unread: st.unread + Math.max(0, s.chat.length - st.chat.length),
    }));
  } else if (guestSession) {
    const g = guestSession;
    useCollab.setState((st) => ({
      me: g.info?.you ?? null,
      peers: [...g.peers.values()],
      presence: { ...g.presence, ...(g.info && st.presence[g.info.you.id] ? { [g.info.you.id]: st.presence[g.info.you.id] } : {}) },
      chat: g.chat,
      unread: st.unread + Math.max(0, g.chat.length - st.chat.length),
    }));
    applyReadOnly();
  }
  renderCarets();
  followIfNeeded();
}

export const markChatRead = () => useCollab.setState({ unread: 0 });

function reset(extra: Partial<ReturnType<typeof useCollab.getState>> = {}) {
  while (cleanups.length) cleanups.pop()!();
  for (const off of bindings.values()) off();
  bindings.clear();
  caretCollection?.clear();
  execOrigin.clear();
  hostSession = null;
  guestSession = null;
  hostRoot = null;
  hostDocs.clear();
  useCollab.setState({ status: 'off', me: null, peers: [], presence: {}, chat: [], unread: 0, invitation: null, addresses: [], project: null, sid: null, follow: null, ...extra });
}

// ---------------------------------------------------------------------------
// Hosting

function hostAdapter(root: string): HostAdapter {
  const abs = (rel: string) => {
    const p = joinRelative(root, rel);
    if (p == null) throw new Error('invalid path');
    return p;
  };
  const rel = (p: string) => relativeTo(root, p) ?? '';
  const kernelInfo = (lang: Lang): KernelStarted => {
    const k = useKernels.getState().kernels[lang];
    return { id: lang, lang, info: { version: k.version, cwd: k.cwd } };
  };
  return {
    projectName: () => root.split(/[\\/]/).filter(Boolean).pop() ?? root,
    async projectInfo() {
      const { useProject } = await import('../project/project');
      const info = useProject.getState().info;
      return info ? { ...info, root: '', python: { ...info.python, venvs: [], uv: null } } : null;
    },
    interpreters: () => LANGS.map((l) => chooseInterpreter(l)).filter((i): i is NonNullable<typeof i> => !!i),
    async docText(r) {
      const p = abs(r);
      return modelForPath(p)?.getValue() ?? host().readText(p);
    },
    async saveDoc(r, text) {
      const p = abs(r);
      if ((await saveByPath(p)) === null) await host().writeText(p, text);
    },
    fs: {
      list: async (r, hidden) => (await host().fsList(abs(r), hidden)).map((e: FsEntry) => ({ ...e, path: rel(e.path) })),
      read: (r) => host().readText(abs(r)),
      writeBase64: (r, data) => host().writeBase64(abs(r), data),
      create: async (r, name, dir) => rel(await host().fsCreate(abs(r), name, dir)),
      rename: async (r, name) => rel(await host().fsRename(abs(r), name)),
      trash: (r) => host().fsTrash(abs(r)),
    },
    kernels: {
      async start(lang, mayStart) {
        if (!isRunning(lang) && mayStart) await startKernel(lang);
        return isRunning(lang) ? kernelInfo(lang) : { id: lang, lang, info: null };
      },
      async execute(lang, code, msgId, by, peerId) {
        execOrigin.set(msgId, peerId);
        void execute(lang, code, { msgId, by });
      },
      call: async (lang, func, args) => (await callHelper(lang, func, args)) ?? null,
      complete: (lang, code, cursor) => host().kernelComplete(lang, code, cursor),
      interrupt: (lang) => interruptKernel(lang),
    },
  };
}

/** Share the open project. Resolves with the invitation link. */
export async function startHosting(opts: { name: string; lan: boolean; defaultRole: Role }): Promise<string | null> {
  const root = getSettings().workdir;
  if (!root) {
    toast({ kind: 'error', title: t('collab.needProject') });
    return null;
  }
  if (isCollabPath(root)) {
    toast({ kind: 'error', title: t('collab.alreadyGuest') });
    return null;
  }
  if (useCollab.getState().status !== 'off') await endSession();
  useCollabPrefs.setState({ name: opts.name, lan: opts.lan, defaultRole: opts.defaultRole });
  useCollab.setState({ status: 'starting', error: null });
  try {
    const info = await host().collabHostStart(opts.lan);
    const sid = Math.random().toString(36).slice(2, 10);
    const session = new HostSession((f) => void host().collabSend(HOST_CONN, f).catch(() => undefined), hostAdapter(root), {
      sid,
      name: cleanName(opts.name, t('collab.hostName')),
      defaultRole: opts.defaultRole,
      onChange: sync,
    });
    hostSession = session;
    hostRoot = root;
    cleanups.push(
      host().onCollabEvent((ev) => {
        if (ev.conn !== HOST_CONN) return;
        if (ev.kind === 'message') session.handleRelay(ev.data);
        else if (hostSession === session) {
          toast({ kind: 'error', title: t('collab.relayLost') });
          void endSession();
        }
      }),
    );
    const local = info.addresses.find((a) => a.startsWith('127.0.0.1:')) ?? info.addresses[0];
    await host().collabConnect(HOST_CONN, local, info.hostToken);
    wireHost(session, root);
    const invitation = formatInvitation({ address: info.addresses[0], token: info.guestToken });
    useCollab.setState({ status: 'hosting', invitation, addresses: info.addresses, lan: info.lan, sid });
    sync();
    return invitation;
  } catch (e) {
    await host().collabHostStop().catch(() => undefined);
    reset({ error: errText(e) });
    toast({ kind: 'error', title: t('collab.startFailed'), detail: errText(e) });
    return null;
  }
}

function wireHost(session: HostSession, root: string) {
  // Kernel output and executions → guests.
  cleanups.push(
    host().onKernelEvent((ev) => {
      if (ev.msgType !== 'dataforge:log') session.kernelEvent(ev);
    }),
    on('kernel:execution-start', ({ lang, msgId, code, echo, by }) => {
      if (!echo) return;
      session.execStarted(lang, msgId, code, by ?? session.me.name, execOrigin.get(msgId));
      execOrigin.delete(msgId);
    }),
    host().onFsChanged((paths) => session.fsChanged(paths.map((p) => relativeTo(root, p)).filter((r): r is string => r != null))),
    on('editor:saved', ({ path }) => {
      const r = relativeTo(root, path);
      if (r) session.docSaved(r);
    }),
  );
  // Every project file open in the editor is shared live.
  cleanups.push(
    onModelCreated((doc, model) => {
      const r = doc.path ? relativeTo(root, doc.path) : null;
      if (!r || bindings.has(model)) return;
      void hostDoc(session, r).then((ydoc) => {
        if (hostSession !== session || model.isDisposed() || bindings.has(model)) return;
        bindings.set(model, bindModel(ydoc.getText(TEXT_KEY), model, LOCAL));
        renderCarets();
      });
    }),
    onModelDisposed((_doc, model) => {
      bindings.get(model)?.();
      bindings.delete(model);
    }),
  );
  wirePresence();
  // Switching to another project ends the session.
  cleanups.push(
    useSettings.subscribe((st, prev) => {
      if (st.workdir !== prev.workdir && hostSession === session) {
        toast({ kind: 'info', title: t('collab.endedProjectChanged') });
        void endSession();
      }
    }),
  );
}

export function setPeerRole(id: string, role: Role) {
  hostSession?.setRole(id, role);
}

export function kickPeer(id: string) {
  hostSession?.kick(id);
}

// ---------------------------------------------------------------------------
// Joining

function guestRouting(session: GuestSession, sid: string): GuestRouting {
  const relOf = (p: string) => {
    const c = parseCollab(p);
    if (!c || c.sid !== sid) throw new Error(t('collab.notThisSession'));
    return c.rel;
  };
  const toPath = (rel: string) => formatCollab(sid, rel);
  const utf8 = (s: string) => toBase64(new TextEncoder().encode(s));
  return {
    fsList: async (p, showHidden) => (await session.rpc<FsEntry[]>('fs.list', { rel: relOf(p), showHidden })).map((e) => ({ ...e, path: toPath(e.path) })),
    async readText(p) {
      const rel = relOf(p);
      const doc = await session.openDoc(rel);
      return doc.getText(TEXT_KEY).toString();
    },
    async writeText(p, content) {
      const rel = relOf(p);
      if (session.docs.has(rel)) session.saveDoc(rel);
      else await session.rpc('fs.write', { rel, data: utf8(content) });
    },
    writeBase64: async (p, data) => void (await session.rpc('fs.write', { rel: relOf(p), data })),
    fsCreate: async (parent, name, dir) => toPath(await session.rpc<string>('fs.create', { rel: relOf(parent), name, dir })),
    fsRename: async (p, name) => toPath(await session.rpc<string>('fs.rename', { rel: relOf(p), name })),
    fsTrash: async (p) => void (await session.rpc('fs.trash', { rel: relOf(p) })),
    async projectInspect(root) {
      const info = await session.rpc<ProjectInfo | null>('project.info');
      const name = session.info?.project ?? 'shared';
      const base: ProjectInfo = info ?? {
        root: '',
        name,
        git: false,
        r: { renv: false, renvLock: false, rproj: null, description: false },
        python: { venvs: [], pyproject: false, uvLock: false, requirements: false, environmentYml: false, uv: null },
      };
      return { ...base, root, name, git: false };
    },
    kernelStart: (_id, lang) => session.rpc<KernelStarted>('kernel.start', { lang }),
    kernelExecute: (id, code, msgId) =>
      mayCall(session.role, 'kernel.execute')
        ? session.rpc<string>('kernel.execute', { lang: id, code, msgId })
        : Promise.reject(new Error(t('collab.cannotRun', { role: t(`collab.role.${session.role}`) }))),
    // Helpers the role doesn't allow (e.g. plot settings) quietly yield nothing.
    kernelCall: async <T,>(id: string, func: string, args: Record<string, unknown>) =>
      mayCall(session.role, 'kernel.call', func) ? session.rpc<T>('kernel.call', { lang: id, func, args }) : (null as T),
    kernelComplete: (id, code, cursor) => session.rpc('kernel.complete', { lang: id, code, cursor }, 10_000),
    kernelInterrupt: (id) => session.rpc('kernel.interrupt', { lang: id }),
  };
}

/** Join a session from an invitation link. */
export async function joinSession(invitation: string, name: string): Promise<boolean> {
  const inv = parseInvitation(invitation);
  if (!inv) {
    toast({ kind: 'error', title: t('collab.badInvitation') });
    return false;
  }
  if (useCollab.getState().status !== 'off') await endSession();
  useCollabPrefs.setState({ name });
  useCollab.setState({ status: 'joining', error: null });
  let session: GuestSession | null = null;
  const adapter: GuestAdapter = {
    onKernelEvent: (ev) => emitGuestKernelEvent(ev),
    onExec: (lang, msgId, code, by) => trackExternalExecution(lang, msgId, code, by),
    onFsChanged: (rels) => emitGuestFsChanged(rels.map((r) => formatCollab(useCollab.getState().sid ?? '', r))),
    onDocSaved: (rel) => markSaved(formatCollab(useCollab.getState().sid ?? '', rel)),
    onRole: (role) => toast({ kind: 'info', title: t('collab.roleChanged', { role: t(`collab.role.${role}`) }) }),
    onEnd: (reason) => {
      if (guestSession === session) void leaveAfterEnd(reason);
    },
  };
  session = new GuestSession((f) => void host().collabSend(GUEST_CONN, f).catch(() => undefined), adapter, { name: cleanName(name), onChange: sync });
  guestSession = session;
  const s = session;
  cleanups.push(
    host().onCollabEvent((ev) => {
      if (ev.conn !== GUEST_CONN) return;
      if (ev.kind === 'message') s.handleFrame(ev.data);
      else s.close(ev.data || 'closed');
    }),
  );
  try {
    await host().collabConnect(GUEST_CONN, inv.address, inv.token);
    const info = await Promise.race([
      s.ready,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(t('collab.noAnswer'))), 15_000)),
    ]);
    previousWorkdir = getSettings().workdir;
    setGuestRouting(guestRouting(s, info.sid));
    setWorkspaceKernels({ interpreter: (lang) => info.interpreters.find((i) => i.lang === lang && i.hasKernel) ?? info.interpreters.find((i) => i.lang === lang) ?? { lang, path: 'host', version: '', hasKernel: true, source: 'session' } });
    useCollab.setState({ status: 'joined', project: info.project, sid: info.sid });
    wireGuest(s, info.sid);
    sync();
    const { openProject } = await import('../project/project');
    await openProject(formatCollab(info.sid, ''));
    if (getSettings().workdir !== formatCollab(info.sid, '')) {
      // Opening was cancelled (unsaved files): don't stay half-joined.
      await endSession();
      return false;
    }
    toast({ kind: 'success', title: t('collab.joined', { project: info.project }) });
    return true;
  } catch (e) {
    await host().collabClose(GUEST_CONN).catch(() => undefined);
    setGuestRouting(null);
    setWorkspaceKernels(null);
    reset({ error: errText(e) });
    toast({ kind: 'error', title: t('collab.joinFailed'), detail: errText(e) });
    return false;
  }
}

function wireGuest(session: GuestSession, sid: string) {
  cleanups.push(
    onModelCreated((doc, model) => {
      const c = doc.path ? parseCollab(doc.path) : null;
      if (!c || c.sid !== sid || bindings.has(model)) return;
      void session.openDoc(c.rel).then((ydoc) => {
        if (guestSession !== session || model.isDisposed() || bindings.has(model)) return;
        bindings.set(model, bindModel(ydoc.getText(TEXT_KEY), model, LOCAL));
        applyReadOnly();
        renderCarets();
      });
    }),
    onModelDisposed((doc, model) => {
      bindings.get(model)?.();
      bindings.delete(model);
      const c = doc.path ? parseCollab(doc.path) : null;
      if (c && c.sid === sid) session.closeDoc(c.rel);
    }),
    useEditor.subscribe((st, prev) => st.activeId !== prev.activeId && applyReadOnly()),
  );
  wirePresence();
}

async function leaveAfterEnd(reason: string) {
  const key = reason === 'removed-by-host' ? 'collab.removed' : reason === 'host-left' || reason === 'session-ended' ? 'collab.hostEnded' : 'collab.connectionLost';
  toast({ kind: 'info', title: t(key) });
  await endSession();
}

/** Stop hosting, or leave the session (restores the previous project). */
export async function endSession() {
  const status = useCollab.getState().status;
  if (hostSession) {
    hostSession.end();
    await new Promise((r) => setTimeout(r, 150));
    await host().collabClose(HOST_CONN).catch(() => undefined);
    await host().collabHostStop().catch(() => undefined);
    reset();
    return;
  }
  if (guestSession || status === 'joined' || status === 'joining') {
    const g = guestSession;
    const sid = useCollab.getState().sid;
    guestSession = null;
    g?.close('left');
    await host().collabClose(GUEST_CONN).catch(() => undefined);
    setGuestRouting(null);
    setWorkspaceKernels(null);
    const back = previousWorkdir;
    previousWorkdir = null;
    reset();
    if (isCollabPath(getSettings().workdir)) {
      // Shared documents live on the host: close them without asking to save.
      useEditor.setState((st) => ({ docs: st.docs.map((d) => (isCollabPath(d.path) ? { ...d, dirty: false } : d)) }));
      const { forgetProject, openProject } = await import('../project/project');
      await openProject(back);
      if (sid) forgetProject(formatCollab(sid, ''));
    }
    return;
  }
  reset();
}

// ---------------------------------------------------------------------------
// Presence: my cursor out, everyone's carets in, follow mode

function relAndDoc(path: string | null): { rel: string; doc: Y.Doc | null } | null {
  if (!path) return null;
  if (hostSession && hostRoot) {
    const rel = relativeTo(hostRoot, path);
    if (!rel) return null;
    return { rel, doc: hostDocs.get(rel) ?? null };
  }
  if (guestSession) {
    const c = parseCollab(path);
    if (!c) return null;
    return { rel: c.rel, doc: guestSession.docs.get(c.rel) ?? null };
  }
  return null;
}

// Host Y.Docs, resolved synchronously for presence/carets (filled as they load).
const hostDocs = new Map<string, Y.Doc>();
async function hostDoc(session: HostSession, rel: string) {
  const d = await session.getDoc(rel);
  if (session === hostSession) hostDocs.set(rel, d);
  return d;
}

function myPresence(): Presence {
  const ed = currentEditor();
  const model = ed?.getModel();
  const d = activeDoc();
  const rd = relAndDoc(d?.path ?? null);
  if (!ed || !model || !rd) return { doc: rd?.rel ?? null, anchor: null, head: null };
  if (hostSession && !rd.doc) void hostDoc(hostSession, rd.rel).then(publishPresence);
  const sel = ed.getSelection();
  if (!sel || !rd.doc) return { doc: rd.rel, anchor: null, head: null, line: sel?.positionLineNumber };
  const text = rd.doc.getText(TEXT_KEY);
  const anchor = model.getOffsetAt({ lineNumber: sel.selectionStartLineNumber, column: sel.selectionStartColumn });
  const head = model.getOffsetAt({ lineNumber: sel.positionLineNumber, column: sel.positionColumn });
  return { doc: rd.rel, anchor: relativeJSON(text, anchor), head: relativeJSON(text, head), line: sel.positionLineNumber };
}

let presenceTimer: ReturnType<typeof setTimeout> | null = null;
function publishPresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    const p = myPresence();
    hostSession?.setPresence(p);
    guestSession?.setPresence(p);
    // Show my own position in the participants list too.
    const me = useCollab.getState().me;
    if (me) useCollab.setState((st) => ({ presence: { ...st.presence, [me.id]: p } }));
  }, 60);
}

function wirePresence() {
  cleanups.push(
    on('editor:cursor', () => {
      publishPresence();
      renderCarets();
    }),
    useEditor.subscribe((st, prev) => {
      if (st.activeId !== prev.activeId) {
        publishPresence();
        setTimeout(renderCarets, 50);
      }
    }),
  );
  // Carets move with remote edits.
  const timer = setInterval(() => bindings.size && renderCarets(), 400);
  cleanups.push(() => clearInterval(timer));
  publishPresence();
}

let caretCollection: M.editor.IEditorDecorationsCollection | null = null;
let caretEditor: M.editor.IStandaloneCodeEditor | null = null;

function renderCarets() {
  const ed = currentEditor();
  const model = ed?.getModel();
  if (!ed) return;
  if (caretEditor !== ed) {
    caretCollection?.clear();
    caretCollection = ed.createDecorationsCollection();
    caretEditor = ed;
  }
  const { presence, peers } = useCollab.getState();
  const rd = relAndDoc(activeDoc()?.path ?? null);
  if (!model || !rd?.doc || (!hostSession && !guestSession)) {
    caretCollection?.clear();
    return;
  }
  const carets: RemoteCaret[] = peers
    .filter((p) => presence[p.id]?.doc === rd.rel)
    .map((p) => ({ id: p.id, name: p.name, color: p.color, anchor: presence[p.id].anchor, head: presence[p.id].head }));
  caretCollection!.set(caretDecorations(model, rd.doc, carets));
}

export function setFollow(id: string | null) {
  useCollab.setState({ follow: id });
  lastFollowed = '';
  followIfNeeded();
}

let lastFollowed = '';
function followIfNeeded() {
  const { follow, presence } = useCollab.getState();
  const p = follow ? presence[follow] : undefined;
  if (!p?.doc) return;
  const key = `${p.doc}:${p.line ?? 0}`;
  if (key === lastFollowed) return;
  lastFollowed = key;
  const path = hostSession && hostRoot ? joinRelative(hostRoot, p.doc) : guestSession ? formatCollab(useCollab.getState().sid ?? '', p.doc) : null;
  if (!path) return;
  if (p.line) openAt(path, p.line);
  else void openFile(path);
}

// ---------------------------------------------------------------------------

function applyReadOnly() {
  const ed = currentEditor();
  if (!ed) return;
  const viewer = !!guestSession && guestSession.role === 'view';
  const shared = isCollabPath(activeDoc()?.path ?? null);
  ed.updateOptions({ readOnly: viewer && shared });
}

export function sendChat(text: string) {
  if (hostSession) hostSession.sendChat(text);
  else guestSession?.sendChat(text);
}

/** Who am I to the others (for the UI). */
export const myRole = (): Role | 'host' | null => (hostSession ? 'host' : (guestSession?.role ?? null));

