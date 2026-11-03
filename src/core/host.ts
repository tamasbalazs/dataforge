/**
 * HostTransport: the only way UI modules talk to the backend. The Tauri
 * implementation calls Rust commands; the mock implementation lets the UI run
 * in a plain browser (development, screenshots, tests).
 */

export type Lang = 'r' | 'python';

export interface Interpreter {
  lang: Lang;
  path: string;
  version: string;
  hasKernel: boolean;
  source: string;
  installHint?: string | null;
  /** R: library holding IRkernel (appended to .libPaths() in renv projects). */
  kernelLib?: string | null;
}

export interface KernelEvent {
  kernelId: string;
  msgType: string;
  parentId: string | null;
  content: any;
}

export interface KernelStarted {
  id: string;
  lang: Lang;
  info: { version?: string; cwd?: string } | null;
}

export interface CompleteReply {
  matches: string[];
  cursor_start: number;
  cursor_end: number;
  status: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  home: string | null;
  cwd: string | null;
  uptimeMs: number;
  /** Folder passed on the command line, opened as the project. */
  launchPath?: string | null;
}

export interface LspCommand {
  name: string;
  program: string;
  args: string[];
}

export interface LspDetection {
  lang: Lang;
  command: LspCommand | null;
  installHint: string | null;
}

export interface LspEvent {
  id: string;
  kind: 'message' | 'log' | 'exit';
  payload: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
  hidden: boolean;
}

export interface ProjectInfo {
  root: string;
  name: string;
  git: boolean;
  r: { renv: boolean; renvLock: boolean; rproj: string | null; description: boolean };
  python: { venvs: Interpreter[]; pyproject: boolean; uvLock: boolean; requirements: boolean; environmentYml: boolean; uv: string | null };
}

export interface ProcStep {
  program: string;
  args: string[];
  /** Extra environment variables for this step. */
  env?: Record<string, string>;
}

export interface ProcEvent {
  id: string;
  kind: 'stdout' | 'stderr' | 'exit';
  text: string;
  code: number | null;
}

export interface PtyEvent {
  id: string;
  /** base64-encoded bytes */
  data: string;
  exit: number | null;
}

export interface PtyOptions {
  shell?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProjectFile {
  path: string;
  size: number;
}

export interface BundleEntryIn {
  name: string;
  source?: string;
  text?: string;
  executable?: boolean;
}

export interface RemoteProfile {
  id: string;
  name: string;
  /** Host name, IP or a Host alias from ~/.ssh/config. */
  host: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
  /** Folder suggested when opening (defaults to the remote home). */
  folder?: string | null;
}

export interface RemoteInfo {
  home: string;
  os: string;
  hostname: string;
  interpreters: Interpreter[];
}

export interface CollabServerInfo {
  port: number;
  hostToken: string;
  guestToken: string;
  /** "ip:port" addresses guests can use (the LAN address first when shared on the network). */
  addresses: string[];
  lan: boolean;
}

export interface CollabEvent {
  conn: string;
  kind: 'message' | 'closed';
  data: string;
}

export interface JobSpecIn {
  name: string;
  /** "stan" | "r-script" | … (for the UI). */
  kind: string;
  program: string;
  args: string[];
  /** Working directory (a workspace path; remote ones are mapped to the host). */
  cwd: string;
  /** Files created in the job folder (name → text). */
  files: Record<string, string>;
  env?: Record<string, string>;
  meta?: unknown;
}

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'lost';

export interface JobInfo {
  id: string;
  name: string;
  kind: string;
  cwd: string;
  /** Job folder on the machine that runs it. */
  dir: string;
  created: number;
  status: JobStatus;
  exitCode: number | null;
  logSize: number;
  meta: any;
}

export interface JobPoll {
  info: JobInfo;
  data: string;
  nextOffset: number;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface Host {
  readonly kind: 'tauri' | 'mock';
  appInfo(): Promise<AppInfo>;
  detectInterpreters(refresh: boolean): Promise<Interpreter[]>;
  kernelStart(id: string, lang: Lang, interpreter: string, cwd?: string | null, kernelLib?: string | null): Promise<KernelStarted>;
  kernelExecute(id: string, code: string, msgId: string): Promise<string>;
  kernelCall<T = unknown>(id: string, func: string, args?: Record<string, unknown>): Promise<T>;
  kernelComplete(id: string, code: string, cursor: number): Promise<CompleteReply>;
  kernelInterrupt(id: string): Promise<void>;
  kernelShutdown(id: string): Promise<void>;
  onKernelEvent(cb: (ev: KernelEvent) => void): () => void;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  writeBase64(path: string, data: string): Promise<void>;
  openFileDialog(filters: FileFilter[]): Promise<string | null>;
  openFolderDialog(): Promise<string | null>;
  saveFileDialog(defaultPath: string, filters: FileFilter[]): Promise<string | null>;
  setZoom(factor: number): Promise<void>;
  lspDetect(lang: Lang, interpreter: string): Promise<LspDetection>;
  lspStart(id: string, command: LspCommand, cwd?: string | null): Promise<void>;
  lspSend(id: string, payload: string): Promise<void>;
  lspStop(id: string): Promise<void>;
  onLspEvent(cb: (ev: LspEvent) => void): () => void;
  fsList(path: string, showHidden: boolean): Promise<FsEntry[]>;
  fsCreate(parent: string, name: string, dir: boolean): Promise<string>;
  fsRename(path: string, newName: string): Promise<string>;
  fsTrash(path: string): Promise<void>;
  fsReveal(path: string): Promise<void>;
  fsOpenExternal(path: string): Promise<void>;
  projectInspect(root: string): Promise<ProjectInfo>;
  projectWatch(root: string | null): Promise<void>;
  onFsChanged(cb: (paths: string[]) => void): () => void;
  procRun(id: string, steps: ProcStep[], cwd?: string | null): Promise<void>;
  procKill(id: string): Promise<void>;
  onProcEvent(cb: (ev: ProcEvent) => void): () => void;
  projectVenvSteps(root: string, python: string): Promise<ProcStep[]>;
  findProgram(name: string): Promise<string | null>;
  /** Scratch folder (outside the project) for a document's rendered preview. */
  previewDir(source: string): Promise<string>;
  openUrl(url: string): Promise<void>;
  /** Open a terminal session; resolves with the shell that was started. */
  ptyOpen(id: string, opts: PtyOptions): Promise<string>;
  ptyWrite(id: string, data: string): Promise<void>;
  ptyResize(id: string, cols: number, rows: number): Promise<void>;
  ptyKill(id: string): Promise<void>;
  onPtyEvent(cb: (ev: PtyEvent) => void): () => void;
  /** DAP request through the Jupyter debug protocol (Python kernels with debugpy). */
  kernelDebug<T = any>(id: string, request: Record<string, unknown>): Promise<T>;
  /** Command for a paused R session (variables/evaluate wait for the answer). */
  rDebug<T = any>(command: Record<string, unknown>, wait: boolean): Promise<T>;
  onRDebugEvent(cb: (ev: any) => void): () => void;
  /** All project files (environments/caches excluded), relative paths. */
  reproFiles(root: string): Promise<ProjectFile[]>;
  /** SHA-256 per relative path (null if unreadable). */
  reproHash(root: string, paths: string[]): Promise<Record<string, string | null>>;
  /** Write a bundle: `dest` ending in .zip → archive, otherwise a new folder. Returns bytes written. */
  reproWrite(dest: string, entries: BundleEntryIn[]): Promise<number>;
  /** Folder where packaged extensions are installed (created on demand). */
  extDir(): Promise<string>;
  /** Install a .dfext package; resolves with the extension id. */
  extInstall(pkg: string): Promise<string>;
  extUninstall(id: string): Promise<void>;
  /** Run `git -C root <args>` non-interactively. */
  gitExec(root: string, args: string[], stdin?: string | null): Promise<GitOutput>;
  /** Open (or reuse) the SSH connection and detect interpreters on the host. */
  remoteConnect(profile: RemoteProfile): Promise<RemoteInfo>;
  remoteDisconnect(id: string): Promise<void>;
  /** Start the session relay (127.0.0.1, or all interfaces with `lan`). */
  collabHostStart(lan: boolean, port?: number | null): Promise<CollabServerInfo>;
  collabHostStop(): Promise<void>;
  /** WebSocket connection to a relay ("ip:port" + token). */
  collabConnect(id: string, address: string, token: string): Promise<void>;
  collabSend(id: string, data: string): Promise<void>;
  collabClose(id: string): Promise<void>;
  onCollabEvent(cb: (ev: CollabEvent) => void): () => void;
  /** Background jobs of a workspace (they run where the project lives and survive the app). */
  jobStart(workdir: string | null, spec: JobSpecIn): Promise<JobInfo>;
  jobList(workdir: string | null): Promise<JobInfo[]>;
  jobPoll(workdir: string | null, id: string, offset: number): Promise<JobPoll>;
  jobCancel(workdir: string | null, id: string): Promise<void>;
  jobRemove(workdir: string | null, id: string): Promise<void>;
  jobRead(workdir: string | null, id: string, name: string): Promise<string>;
  /** Show the (initially hidden) window once the UI has painted. */
  showWindow(): Promise<void>;
}

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let instance: Host | null = null;

export async function initHost(): Promise<Host> {
  if (instance) return instance;
  let base: Host;
  if (isTauri()) {
    const { createTauriHost } = await import('./host.tauri');
    base = createTauriHost();
  } else {
    const { createMockHost } = await import('./host.mock');
    base = createMockHost();
  }
  const { wrapHost } = await import('./hostRouter');
  instance = wrapHost(base);
  return instance;
}

export function host(): Host {
  if (!instance) throw new Error('Host not initialised');
  return instance;
}

/** For tests. */
export function setHost(h: Host | null) {
  instance = h;
}
