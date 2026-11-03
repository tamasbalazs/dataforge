import { describe, expect, it } from 'vitest';
import { completionKind, editsForUri, isKernelGlobalDiagnostic, markerSeverity, pathToUri, toLspPosition, toMarkdown, toMonacoRange } from './convert';

describe('LSP conversions', () => {
  it('converts positions and ranges between 0- and 1-based', () => {
    expect(toLspPosition({ lineNumber: 1, column: 1 })).toEqual({ line: 0, character: 0 });
    expect(toMonacoRange({ start: { line: 2, character: 4 }, end: { line: 2, character: 9 } })).toEqual({
      startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 10,
    });
  });

  it('maps severities and completion kinds', () => {
    expect(markerSeverity(1)).toBe(8);
    expect(markerSeverity(2)).toBe(4);
    expect(completionKind(3, { Function: 1, Text: 18 })).toBe(1);
    expect(completionKind(undefined, { Function: 1, Text: 18 })).toBe(18);
  });

  it('normalises hover contents to markdown', () => {
    expect(toMarkdown({ kind: 'markdown', value: '**x**' })).toEqual(['**x**']);
    expect(toMarkdown({ kind: 'plaintext', value: 'a<b' })).toEqual(['```\na<b\n```']);
    expect(toMarkdown([{ language: 'python', value: 'def f()' }, 'doc'])).toEqual(['```python\ndef f()\n```', 'doc']);
    expect(toMarkdown(null)).toEqual([]);
  });

  it('extracts edits for a document from workspace edits', () => {
    const e = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' };
    expect(editsForUri({ changes: { 'file:///a.py': [e] } }, 'file:///a.py')).toEqual([e]);
    expect(editsForUri({ documentChanges: [{ textDocument: { uri: 'file:///A.py' }, edits: [e] }] }, 'file:///a.py')).toEqual([e]);
  });

  it('builds file URIs', () => {
    expect(pathToUri('/home/me/my file.R')).toBe('file:///home/me/my%20file.R');
    expect(pathToUri('C:\\Users\\me\\a.py')).toBe('file:///C:/Users/me/a.py');
  });

  it('hides diagnostics about names the kernels inject', () => {
    expect(isKernelGlobalDiagnostic('"r" is not defined')).toBe(true);
    expect(isKernelGlobalDiagnostic('"View" is not defined')).toBe(true);
    expect(isKernelGlobalDiagnostic("no visible binding for global variable ‘py’")).toBe(true);
    expect(isKernelGlobalDiagnostic('"rr" is not defined')).toBe(false);
    expect(isKernelGlobalDiagnostic('Expected expression')).toBe(false);
  });
});
