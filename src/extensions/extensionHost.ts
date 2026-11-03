/**
 * Extension host: discovers installed extensions, asks for consent to their
 * permissions, runs each one in its own worker and routes its API calls
 * (checked by `authorize`) to the app. Contributions — commands, panels,
 * snippets, themes — are registered on activation and removed on deactivation.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { findCommandForChord, registerCommands } from '../core/commands';
import { ask } from '../core/dialog';
import { host, type Lang } from '../core/host';
import { t } from '../core/i18n';
import { getSettings } from '../core/settings';
import { toast } from '../core/toast';
import { callHelper, execute, startKernel } from '../kernels/kernels';
import { setExtensionThemes } from '../themes/themeStore';
import { parseJsonc, parseThemeFile, slug } from '../themes/themeModel';
import { authorize, ENGINE_VERSION, MANIFEST_FILE, parseSnippets, validateManifest, type ExtensionManifest, type Permission } from './manifest';
import { workerSource } from './prelude';
import { removeSnippets, setSnippets } from './snippets';

export interface InstalledExtension {
  /** Folder of the extension. */
  dir: string;
  /** Loaded from a development folder (not installed). */
  dev: boolean;
  manifest?: ExtensionManifest;
  errors: string[];
}

export type ExtStatus = 'disabled' | 'needsConsent' | 'loading' | 'active' | 'error';

interface ExtState {
  list: InstalledExtension[];
  /** Extension id → enabled (persisted). */
  enabled: Record<string, boolean>;
  /** Extension id → permissions the user approved (persisted). */
  consent: Record<string, Permission[]>;
  devFolders: string[];
  status: Record<string, ExtStatus>;
  errors: Record<string, string>;
  /** Panel key (ext:<id>:<panel>) → HTML set by the extension. */
  panelHtml: Record<string, string>;
  storage: Record<string, Record<string, unknown>>;
  loaded: boolean;
}

export const useExtensions = create<ExtState>()(
  persist(
    (): ExtState => ({ list: [], enabled: {}, consent: {}, devFolders: [], status: {}, errors: {}, panelHtml: {}, storage: {}, loaded: false }),
    { name: 'dataforge.extensions', version: 1, partialize: (s) => ({ enabled: s.enabled, consent: s.consent, devFolders: s.devFolders, storage: s.storage }) },
  ),
);

export const panelKey = (extId: string, panelId: string) => `ext:${extId}:${panelId}`;
const join = (dir: string, rel: string) => `${dir.replace(/[\\/]+$/, '')}/${rel}`;

interface Running {
  worker: Worker | null;
  dispose: Array<() => void>;
  commandWaiters: Map<number, (err?: string) => void>;
  urls: string[];
}

const running = new Map<string, Running>();
let commandSeq = 0;

/** Listeners of messages from an extension to one of its panels (the panel view subscribes). */
const panelListeners = new Map<string, Set<(msg: unknown) => void>>();
export function onPanelMessage(key: string, fn: (msg: unknown) => void) {
  const set = panelListeners.get(key) ?? panelListeners.set(key, new Set()).get(key)!;
  set.add(fn);
  return () => set.delete(fn);
}

/** A panel view forwards messages from its iframe to the extension. */
export function sendToExtension(extId: string, panelId: string, message: unknown) {
  running.get(extId)?.worker?.postMessage({ type: 'panelMessage', panel: panelId, message });
}

// The UI layer provides these (keeps this module free of React/layout imports).
export interface HostBindings {
  openPanel(extId: string, panelId: string, title: string): void;
  closePanels(extId: string): void;
  selection(): { text: string; word: string; language: string; path: string | null };
  text(): string;
  insert(text: string, position: 'cursor' | 'newLine'): boolean;
}
let bindings: HostBindings | null = null;
export const setHostBindings = (b: HostBindings) => (bindings = b);

// ---------------------------------------------------------------------------
// Discovery

async function readManifest(dir: string, dev: boolean): Promise<InstalledExtension> {
  try {
    const raw = parseJsonc(await host().readText(join(dir, MANIFEST_FILE)));
    const { manifest, errors } = validateManifest(raw);
    return { dir, dev, manifest, errors };
  } catch (e) {
    return { dir, dev, errors: [String(e)] };
  }
}

export async function discover(): Promise<InstalledExtension[]> {
  const out: InstalledExtension[] = [];
  try {
    const root = await host().extDir();
    for (const e of await host().fsList(root, false)) if (e.isDir) out.push(await readManifest(e.path, false));
  } catch (e) {
    console.warn('extension folder unavailable', e);
  }
  for (const d of useExtensions.getState().devFolders) out.push(await readManifest(d, true));
  // A dev folder overrides an installed copy with the same id.
  const byId = new Map<string, InstalledExtension>();
  const broken: InstalledExtension[] = [];
  for (const x of out) {
    if (!x.manifest) broken.push(x);
    else if (!byId.has(x.manifest.id) || x.dev) byId.set(x.manifest.id, x);
  }
  return [...byId.values(), ...broken].sort((a, b) => (a.manifest?.name ?? a.dir).localeCompare(b.manifest?.name ?? b.dir));
}

/** (Re)load every extension and activate the enabled, consented ones. */
export async function loadExtensions() {
  for (const id of [...running.keys()]) deactivate(id);
  const list = await discover();
  useExtensions.setState({ list, loaded: true });
  for (const x of list) {
    if (!x.manifest) continue;
    const id = x.manifest.id;
    const s = useExtensions.getState();
    if (s.enabled[id] === false) setStatus(id, 'disabled');
    else if (!hasConsent(x.manifest)) setStatus(id, 'needsConsent');
    else void activate(x);
  }
}

const setStatus = (id: string, status: ExtStatus, error?: string) =>
  useExtensions.setState((s) => ({ status: { ...s.status, [id]: status }, errors: { ...s.errors, [id]: error ?? '' } }));

const hasConsent = (m: ExtensionManifest) => {
  const approved = useExtensions.getState().consent[m.id];
  return !!approved && m.permissions.every((p) => approved.includes(p));
};

/** Ask the user to approve an extension's permissions. */
export async function requestConsent(m: ExtensionManifest): Promise<boolean> {
  const perms = m.permissions.length ? m.permissions.map((p) => `• ${t(`extensions.perm.${p}`)}`).join('\n') : t('extensions.noPermissions');
  const choice = await ask(t('extensions.consentTitle', { name: m.name, version: m.version }), `${t('extensions.consentBody', { author: m.author ?? '?' })}\n\n${perms}`, [
    { id: 'allow', label: t('extensions.allow'), variant: 'primary' },
    { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
  ]);
  if (choice !== 'allow') return false;
  useExtensions.setState((s) => ({ consent: { ...s.consent, [m.id]: [...m.permissions] }, enabled: { ...s.enabled, [m.id]: true } }));
  return true;
}

export async function enableExtension(id: string, on: boolean) {
  try {
    await setEnabled(id, on);
  } catch (e) {
    toast({ kind: 'error', title: t('extensions.commandFailed', { name: id }), detail: String(e) });
  }
}

async function setEnabled(id: string, on: boolean) {
  const x = useExtensions.getState().list.find((e) => e.manifest?.id === id);
  if (!x?.manifest) return;
  if (on && !hasConsent(x.manifest) && !(await requestConsent(x.manifest))) return;
  useExtensions.setState((s) => ({ enabled: { ...s.enabled, [id]: on } }));
  if (on) await activate(x);
  else {
    deactivate(id);
    setStatus(id, 'disabled');
  }
}

// ---------------------------------------------------------------------------
// Activation

async function activate(x: InstalledExtension) {
  const m = x.manifest!;
  deactivate(m.id);
  setStatus(m.id, 'loading');
  const run: Running = { worker: null, dispose: [], commandWaiters: new Map(), urls: [] };
  running.set(m.id, run);
  try {
    // Themes and snippets are data: they work without running any code.
    const themes = [];
    for (const th of m.contributes.themes) {
      const parsed = parseThemeFile(await host().readText(join(x.dir, th.path)), th.label ?? th.path);
      themes.push({ ...parsed, id: `ext-${slug(m.id)}-${slug(th.label ?? parsed.name)}`, name: th.label ?? parsed.name, source: 'extension' as const, extensionId: m.id });
    }
    setExtensionThemes(m.id, themes);
    run.dispose.push(() => setExtensionThemes(m.id, []));
    for (const sn of m.contributes.snippets) {
      setSnippets(`${m.id}:${sn.path}`, sn.language, parseSnippets(parseJsonc(await host().readText(join(x.dir, sn.path)))), m.name);
    }
    run.dispose.push(() => removeSnippets(`${m.id}:`));

    if (m.main) {
      const source = await host().readText(join(x.dir, m.main));
      const mainUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const bootUrl = URL.createObjectURL(new Blob([workerSource(m.permissions, ENGINE_VERSION)], { type: 'text/javascript' }));
      run.urls.push(mainUrl, bootUrl);
      const worker = new Worker(bootUrl, { type: 'module', name: `ext:${m.id}` });
      run.worker = worker;
      worker.onmessage = (e) => void onWorkerMessage(m, run, e.data);
      worker.onerror = (e) => setStatus(m.id, 'error', e.message);
      const activated = new Promise<string | undefined>((resolve) => {
        const prev = worker.onmessage;
        worker.onmessage = (e) => {
          if (e.data?.type === 'activated') {
            worker.onmessage = prev;
            resolve(e.data.error);
          } else prev?.call(worker, e);
        };
      });
      worker.postMessage({ type: 'activate', url: mainUrl });
      const error = await Promise.race([activated, new Promise<string>((r) => setTimeout(() => r('activation timed out (10 s)'), 10000))]);
      if (error) throw new Error(error);
      // Commands: declared in the manifest, handled in the worker.
      // Built-in shortcuts win; a clashing extension keybinding is dropped (and reported).
      const clashes = m.contributes.commands.filter((c) => c.keybinding && findCommandForChord(c.keybinding));
      if (clashes.length) toast({ kind: 'info', title: t('extensions.keyClash', { name: m.name, keys: clashes.map((c) => c.keybinding).join(', ') }) });
      const off = registerCommands(
        m.contributes.commands.map((c) => ({
          id: `ext.${m.id}.${c.id}`,
          title: c.title,
          category: m.name,
          literal: true,
          keybinding: clashes.includes(c) ? undefined : c.keybinding,
          run: () => invokeCommand(m, run, c.id),
        })),
      );
      run.dispose.push(off);
    }
    setStatus(m.id, 'active');
  } catch (e) {
    deactivate(m.id);
    setStatus(m.id, 'error', String(e).replace(/^Error:\s*/, ''));
  }
}

function deactivate(id: string) {
  const run = running.get(id);
  if (!run) return;
  running.delete(id);
  run.worker?.terminate();
  run.dispose.forEach((d) => d());
  run.urls.forEach((u) => URL.revokeObjectURL(u));
  run.commandWaiters.forEach((w) => w('extension stopped'));
  bindings?.closePanels(id);
}

function invokeCommand(m: ExtensionManifest, run: Running, command: string): Promise<void> {
  return new Promise((resolve) => {
    const id = ++commandSeq;
    run.commandWaiters.set(id, (err) => {
      run.commandWaiters.delete(id);
      if (err) toast({ kind: 'error', title: t('extensions.commandFailed', { name: m.name }), detail: err });
      resolve();
    });
    run.worker?.postMessage({ type: 'command', id, command });
  });
}

async function onWorkerMessage(m: ExtensionManifest, run: Running, msg: any) {
  if (msg?.type === 'commandDone') run.commandWaiters.get(msg.id)?.(msg.error);
  else if (msg?.type === 'log') console[msg.level === 'error' ? 'error' : 'log'](`[${m.id}]`, msg.text);
  else if (msg?.type === 'call') {
    const reply = (value: unknown, error?: string) => run.worker?.postMessage({ type: 'result', id: msg.id, value, error });
    const args: unknown[] = Array.isArray(msg.args) ? msg.args : [];
    const denied = authorize(m, msg.method, args);
    if (denied) return reply(undefined, denied);
    try {
      reply(await dispatch(m, msg.method, args));
    } catch (e) {
      reply(undefined, String(e).replace(/^Error:\s*/, ''));
    }
  }
}

/** The extension API, after `authorize` has approved the call. */
async function dispatch(m: ExtensionManifest, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'window.showMessage': {
      const kind = args[1] === 'error' ? 'error' : args[1] === 'success' ? 'success' : 'info';
      toast({ kind, title: String(args[0]).slice(0, 300), detail: m.name });
      return true;
    }
    case 'commands.register':
      return true; // the manifest declares commands; the worker keeps the handler
    case 'editor.getSelection':
      return bindings?.selection() ?? null;
    case 'editor.getText':
      return bindings?.text() ?? '';
    case 'editor.insertText':
      return bindings?.insert(String(args[0]), args[1] === 'newLine' ? 'newLine' : 'cursor') ?? false;
    case 'kernel.execute': {
      const id = await execute(args[0] as Lang, String(args[1]));
      return !!id;
    }
    case 'kernel.evaluate': {
      const lang = args[0] as Lang;
      if (!(await startKernel(lang))) throw new Error(t('kernel.unavailable'));
      return await callHelper<string>(lang, 'ext_eval', { code: String(args[1]) });
    }
    case 'workspace.root':
      return getSettings().workdir;
    case 'workspace.listFiles': {
      const root = getSettings().workdir;
      return root ? (await host().reproFiles(root)).map((f) => f.path) : [];
    }
    case 'workspace.readFile': {
      const root = getSettings().workdir;
      if (!root) throw new Error('no project is open');
      return await host().readText(join(root, String(args[0])));
    }
    case 'panels.show': {
      const p = m.contributes.panels.find((x) => x.id === args[0])!;
      bindings?.openPanel(m.id, p.id, p.title);
      return true;
    }
    case 'panels.setHtml': {
      const key = panelKey(m.id, String(args[0]));
      useExtensions.setState((s) => ({ panelHtml: { ...s.panelHtml, [key]: String(args[1]).slice(0, 2_000_000) } }));
      return true;
    }
    case 'panels.postMessage': {
      panelListeners.get(panelKey(m.id, String(args[0])))?.forEach((fn) => fn(args[1]));
      return true;
    }
    case 'storage.get':
      return useExtensions.getState().storage[m.id]?.[String(args[0])] ?? null;
    case 'storage.set': {
      const text = JSON.stringify(args[1] ?? null);
      if (text.length > 100_000) throw new Error('value too large (100 KB)');
      useExtensions.setState((s) => ({ storage: { ...s.storage, [m.id]: { ...s.storage[m.id], [String(args[0])]: JSON.parse(text) } } }));
      return true;
    }
  }
  throw new Error(`unknown API method ${method}`);
}

// ---------------------------------------------------------------------------
// Install / uninstall

export async function installFromPackage(path?: string) {
  const p = path ?? (await host().openFileDialog([{ name: 'DataForge extension', extensions: ['dfext', 'zip'] }]));
  if (!p) return;
  try {
    const id = await host().extInstall(p);
    await loadExtensions();
    const x = useExtensions.getState().list.find((e) => e.manifest?.id === id);
    if (x?.manifest && !hasConsent(x.manifest)) await enableExtension(id, true);
    toast({ kind: 'success', title: t('extensions.installed', { name: x?.manifest?.name ?? id }) });
  } catch (e) {
    toast({ kind: 'error', title: t('extensions.installFailed'), detail: String(e) });
  }
}

export async function addDevFolder(path?: string) {
  const p = path ?? (await host().openFolderDialog());
  if (!p) return;
  const x = await readManifest(p, true);
  if (!x.manifest) {
    toast({ kind: 'error', title: t('extensions.invalidFolder'), detail: x.errors.join('\n') });
    return;
  }
  useExtensions.setState((s) => ({ devFolders: [...s.devFolders.filter((d) => d !== p), p] }));
  await loadExtensions();
  if (!hasConsent(x.manifest)) await enableExtension(x.manifest.id, true);
}

export async function uninstallExtension(x: InstalledExtension) {
  const name = x.manifest?.name ?? x.dir;
  const choice = await ask(t('extensions.uninstallTitle', { name }), x.dev ? t('extensions.removeDevBody') : t('extensions.uninstallBody'), [
    { id: 'remove', label: x.dev ? t('extensions.removeDev') : t('extensions.uninstall'), variant: 'danger' },
    { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
  ]);
  if (choice !== 'remove') return;
  const id = x.manifest?.id;
  if (id) deactivate(id);
  if (x.dev) useExtensions.setState((s) => ({ devFolders: s.devFolders.filter((d) => d !== x.dir) }));
  else if (id) await host().extUninstall(id).catch((e) => toast({ kind: 'error', title: String(e) }));
  if (id) useExtensions.setState((s) => {
    const { [id]: _a, ...consent } = s.consent;
    const { [id]: _b, ...enabled } = s.enabled;
    return { consent, enabled };
  });
  await loadExtensions();
}

export function installExtensionListeners(): () => void {
  void loadExtensions();
  return () => {
    for (const id of [...running.keys()]) deactivate(id);
  };
}
