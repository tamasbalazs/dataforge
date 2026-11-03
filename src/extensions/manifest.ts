/**
 * Extension manifest (dataforge-extension.json) and the permission policy of
 * the extension API. Pure functions, unit-tested.
 */

export type Permission = 'editor' | 'kernel' | 'workspace' | 'network';
export const PERMISSIONS: Permission[] = ['editor', 'kernel', 'workspace', 'network'];

export interface CommandContribution {
  id: string;
  title: string;
  keybinding?: string;
}

export interface PanelContribution {
  id: string;
  title: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  engines?: { dataforge?: string };
  main?: string;
  permissions: Permission[];
  contributes: {
    commands: CommandContribution[];
    panels: PanelContribution[];
    themes: Array<{ label?: string; path: string }>;
    snippets: Array<{ language: 'r' | 'python'; path: string }>;
  };
}

export const MANIFEST_FILE = 'dataforge-extension.json';
export const ENGINE_VERSION = '0.1.0';

const ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const LOCAL_ID = /^[A-Za-z][\w.-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
// Relative path inside the extension folder.
const REL_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/;

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);

/** Validate a parsed manifest; returns the normalized manifest or the list of problems. */
export function validateManifest(raw: unknown): { manifest?: ExtensionManifest; errors: string[] } {
  const errors: string[] = [];
  const m = (raw ?? {}) as Record<string, any>;
  const id = str(m.id, 120);
  if (!id || !ID.test(id)) errors.push('id must look like "publisher.name" (lowercase letters, digits, dashes)');
  const name = str(m.name, 80);
  if (!name) errors.push('name is required');
  const version = str(m.version, 40);
  if (!version || !VERSION.test(version)) errors.push('version must be semantic (e.g. 1.0.0)');
  if (m.main != null && (typeof m.main !== 'string' || !REL_PATH.test(m.main) || !/\.m?js$/.test(m.main))) errors.push('main must be a relative .js file');
  const permissions: Permission[] = [];
  for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
    if (PERMISSIONS.includes(p)) permissions.push(p);
    else errors.push(`unknown permission "${p}"`);
  }
  const c = (m.contributes ?? {}) as Record<string, any>;
  const commands: CommandContribution[] = [];
  for (const x of Array.isArray(c.commands) ? c.commands : []) {
    const cid = str(x?.id, 64);
    const title = str(x?.title, 120);
    if (!cid || !LOCAL_ID.test(cid) || !title) errors.push(`invalid command ${JSON.stringify(x?.id)}`);
    else commands.push({ id: cid, title, keybinding: str(x.keybinding, 40) });
  }
  const panels: PanelContribution[] = [];
  for (const x of Array.isArray(c.panels) ? c.panels : []) {
    const pid = str(x?.id, 64);
    const title = str(x?.title, 80);
    if (!pid || !LOCAL_ID.test(pid) || !title) errors.push(`invalid panel ${JSON.stringify(x?.id)}`);
    else panels.push({ id: pid, title });
  }
  const themes: Array<{ label?: string; path: string }> = [];
  for (const x of Array.isArray(c.themes) ? c.themes : []) {
    if (typeof x?.path !== 'string' || !REL_PATH.test(x.path)) errors.push(`invalid theme path ${JSON.stringify(x?.path)}`);
    else themes.push({ label: str(x.label, 80), path: x.path });
  }
  const snippets: Array<{ language: 'r' | 'python'; path: string }> = [];
  for (const x of Array.isArray(c.snippets) ? c.snippets : []) {
    if ((x?.language !== 'r' && x?.language !== 'python') || typeof x?.path !== 'string' || !REL_PATH.test(x.path)) errors.push(`invalid snippets entry ${JSON.stringify(x)}`);
    else snippets.push({ language: x.language, path: x.path });
  }
  if ((commands.length || panels.length) && !m.main) errors.push('commands and panels need a "main" script');
  const engine = str(m.engines?.dataforge, 20);
  if (engine && !engineSatisfied(engine, ENGINE_VERSION)) errors.push(`requires DataForge ${engine} (this is ${ENGINE_VERSION})`);
  if (errors.length) return { errors };
  return {
    errors,
    manifest: {
      id: id!,
      name: name!,
      version: version!,
      description: str(m.description, 300),
      author: str(m.author, 80),
      license: str(m.license, 40),
      engines: engine ? { dataforge: engine } : undefined,
      main: m.main,
      permissions,
      contributes: { commands, panels, themes, snippets },
    },
  };
}

const parts = (v: string) => [...v.split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0), 0, 0, 0].slice(0, 3);

/** Supports ">=x.y[.z]", "^x.y[.z]", "x.y.z" and "*". */
export function engineSatisfied(range: string, version: string): boolean {
  const v = parts(version);
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const r = range.trim();
  if (r === '*' || r === '') return true;
  if (r.startsWith('>=')) return cmp(v, parts(r.slice(2))) >= 0;
  if (r.startsWith('^')) {
    const b = parts(r.slice(1));
    // ^0.y means 0.y.* (like npm)
    return cmp(v, b) >= 0 && (b[0] > 0 ? v[0] === b[0] : v[1] === b[1]);
  }
  return cmp(v, parts(r)) === 0;
}

/** Which permission an API method needs (null = always allowed). */
export const METHOD_PERMISSION: Record<string, Permission | null> = {
  'window.showMessage': null,
  'commands.register': null,
  'panels.show': null,
  'panels.setHtml': null,
  'panels.postMessage': null,
  'storage.get': null,
  'storage.set': null,
  'editor.getSelection': 'editor',
  'editor.getText': 'editor',
  'editor.insertText': 'editor',
  'kernel.execute': 'kernel',
  'kernel.evaluate': 'kernel',
  'workspace.root': 'workspace',
  'workspace.listFiles': 'workspace',
  'workspace.readFile': 'workspace',
};

/** Whether `method` may be called; also checks declared commands/panels. */
export function authorize(m: ExtensionManifest, method: string, args: unknown[]): string | null {
  if (!(method in METHOD_PERMISSION)) return `unknown API method ${method}`;
  const need = METHOD_PERMISSION[method];
  if (need && !m.permissions.includes(need)) return `"${method}" needs the "${need}" permission in the manifest`;
  if (method === 'commands.register' && !m.contributes.commands.some((c) => c.id === args[0])) return `command "${args[0]}" is not declared in contributes.commands`;
  if (method.startsWith('panels.') && !m.contributes.panels.some((p) => p.id === args[0])) return `panel "${args[0]}" is not declared in contributes.panels`;
  if ((method === 'kernel.execute' || method === 'kernel.evaluate') && args[0] !== 'r' && args[0] !== 'python') return 'language must be "r" or "python"';
  if (method === 'workspace.readFile' && (typeof args[0] !== 'string' || !REL_PATH.test(args[0]))) return 'path must be relative to the project';
  return null;
}

/** VS Code snippet file → Monaco completion items. */
export interface Snippet {
  label: string;
  prefix: string;
  body: string;
  description?: string;
}

export function parseSnippets(json: unknown): Snippet[] {
  const out: Snippet[] = [];
  if (!json || typeof json !== 'object') return out;
  for (const [label, s] of Object.entries(json as Record<string, any>)) {
    const prefixes = Array.isArray(s?.prefix) ? s.prefix : [s?.prefix];
    const body = Array.isArray(s?.body) ? s.body.join('\n') : s?.body;
    if (typeof body !== 'string') continue;
    for (const p of prefixes) if (typeof p === 'string' && p) out.push({ label, prefix: p, body, description: typeof s.description === 'string' ? s.description : undefined });
  }
  return out;
}
