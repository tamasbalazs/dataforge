/**
 * Bootstrap code of an extension worker. The extension's module runs inside a
 * dedicated Web Worker: no DOM, no Tauri IPC — only the `dataforge` API below,
 * whose calls are checked against the manifest by the host. Without the
 * "network" permission, the worker's network primitives are replaced with stubs.
 */
import type { Permission } from './manifest';

export function workerSource(permissions: Permission[], engineVersion: string): string {
  return `
const PERMS = new Set(${JSON.stringify(permissions)});
if (!PERMS.has('network')) {
  const blocked = function () { throw new Error('This extension has no "network" permission'); };
  for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'WebTransport']) {
    try { Object.defineProperty(self, k, { value: blocked, writable: false, configurable: false }); } catch (e) {}
    for (let p = Object.getPrototypeOf(self); p; p = Object.getPrototypeOf(p)) {
      try { if (Object.prototype.hasOwnProperty.call(p, k)) Object.defineProperty(p, k, { value: blocked, writable: false, configurable: false }); } catch (e) {}
    }
  }
}
let seq = 0;
const pending = new Map();
const commands = new Map();
const panelHandlers = new Map();
const call = (method, ...args) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  postMessage({ type: 'call', id, method, args });
});
const dataforge = Object.freeze({
  version: ${JSON.stringify(engineVersion)},
  commands: Object.freeze({
    register: (id, fn) => { if (typeof fn !== 'function') throw new TypeError('handler must be a function'); commands.set(id, fn); return call('commands.register', id); },
  }),
  window: Object.freeze({ showMessage: (text, kind = 'info') => call('window.showMessage', String(text), String(kind)) }),
  editor: Object.freeze({
    getSelection: () => call('editor.getSelection'),
    getText: () => call('editor.getText'),
    insertText: (text, options) => call('editor.insertText', String(text), options && options.position === 'newLine' ? 'newLine' : 'cursor'),
  }),
  kernel: Object.freeze({
    execute: (lang, code) => call('kernel.execute', lang, String(code)),
    evaluate: (lang, code) => call('kernel.evaluate', lang, String(code)),
  }),
  workspace: Object.freeze({
    root: () => call('workspace.root'),
    listFiles: () => call('workspace.listFiles'),
    readFile: (path) => call('workspace.readFile', String(path)),
  }),
  panels: Object.freeze({
    show: (id) => call('panels.show', id),
    setHtml: (id, html) => call('panels.setHtml', id, String(html)),
    postMessage: (id, message) => call('panels.postMessage', id, message),
    onMessage: (id, fn) => { panelHandlers.set(id, fn); },
  }),
  storage: Object.freeze({
    get: (key) => call('storage.get', String(key)),
    set: (key, value) => call('storage.set', String(key), value),
  }),
});
self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'result') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
  } else if (m.type === 'command') {
    const fn = commands.get(m.command);
    try {
      if (!fn) throw new Error('command not registered: ' + m.command);
      await fn();
      postMessage({ type: 'commandDone', id: m.id });
    } catch (err) {
      postMessage({ type: 'commandDone', id: m.id, error: String((err && err.message) || err) });
    }
  } else if (m.type === 'panelMessage') {
    try { await panelHandlers.get(m.panel)?.(m.message); } catch (err) { postMessage({ type: 'log', level: 'error', text: String(err) }); }
  } else if (m.type === 'activate') {
    try {
      const mod = await import(m.url);
      if (typeof mod.activate === 'function') await mod.activate(dataforge);
      postMessage({ type: 'activated' });
    } catch (err) {
      postMessage({ type: 'activated', error: String((err && (err.stack || err.message)) || err) });
    }
  }
};
`;
}
