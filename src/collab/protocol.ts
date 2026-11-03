/**
 * Collaboration protocol: invitation format, roles and what each role may do,
 * peer colours, and the messages exchanged between host and guests.
 * (The relay only routes; every permission is checked by the host here.)
 */
import type { Interpreter, KernelEvent, Lang } from '../core/host';

export type Role = 'view' | 'edit' | 'run';
export const ROLES: Role[] = ['view', 'edit', 'run'];

/** Methods a guest may call over RPC, with the minimum role. */
export const RPC_ROLE: Record<string, Role> = {
  'fs.list': 'view',
  'fs.read': 'view',
  'project.info': 'view',
  'kernel.start': 'view',
  'kernel.call': 'view', // narrowed further by READONLY_HELPERS
  'kernel.complete': 'view',
  'fs.write': 'edit',
  'fs.create': 'edit',
  'fs.rename': 'edit',
  'fs.trash': 'edit',
  'kernel.execute': 'run',
  'kernel.interrupt': 'run',
};

/** Kernel helpers that only read (Environment panel, data viewer, help, packages). */
export const READONLY_HELPERS = new Set([
  'info',
  'env_list',
  'data_info',
  'data_page',
  'data_stats',
  'data_release',
  'help_html',
  'help_doc',
  'help_search',
  'packages',
  'lib_info',
  'repro_info',
]);

const RANK: Record<Role, number> = { view: 0, edit: 1, run: 2 };
export const roleAllows = (role: Role, needed: Role) => RANK[role] >= RANK[needed];

/** May a guest with `role` call `method` (and, for kernel.call, `func`)? */
export function mayCall(role: Role, method: string, func?: string): boolean {
  const needed = RPC_ROLE[method];
  if (!needed || !roleAllows(role, needed)) return false;
  if (method === 'kernel.call' && !roleAllows(role, 'run')) return !!func && READONLY_HELPERS.has(func);
  return true;
}

// --- Invitations -------------------------------------------------------------
export interface Invitation {
  address: string; // "ip:port"
  token: string;
}

const INVITE_PREFIX = 'dataforge://join/';

export const formatInvitation = (i: Invitation) => `${INVITE_PREFIX}${i.address}/${i.token}`;

/** Accepts the full link, or "address token" / "address/token" pasted by hand. */
export function parseInvitation(input: string): Invitation | null {
  const s = input.trim().replace(/^dataforge:\/\/join\//, '').replace(/^\/+/, '');
  const m = /^([A-Za-z0-9.\-[\]:]+:\d{1,5})[\s/]+([A-Za-z0-9]{16,128})\/?$/.exec(s);
  if (!m) return null;
  const port = Number(m[1].split(':').pop());
  if (!(port > 0 && port < 65536)) return null;
  return { address: m[1], token: m[2] };
}

// --- Peers ---------------------------------------------------------------------
/** Peer colours: distinct hues that stay readable on light and dark themes. */
export const PEER_COLORS = ['#E5484D', '#3E9B4F', '#7C66DC', '#D97706', '#0EA5B7', '#D6409F', '#5B8DEF', '#8D6E3F'];

/** Black or white, whichever reads better on `bg` (avatars, caret labels). */
export function readableText(bg: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (1.05 / (l + 0.05) >= (l + 0.05) / 0.05) ? '#FFFFFF' : '#111111';
}

export interface Peer {
  id: string;
  name: string;
  color: string;
  role: Role | 'host';
}

export interface Presence {
  /** Project-relative path of the document the peer looks at. */
  doc: string | null;
  /** Y.RelativePosition JSON of selection anchor and head. */
  anchor: unknown | null;
  head: unknown | null;
  line?: number;
}

export interface ChatMessage {
  id: string;
  peer: string;
  name: string;
  color: string;
  text: string;
  ts: number;
}

export const MAX_CHAT = 200;
export const MAX_CHAT_LEN = 2000;

// --- Messages ------------------------------------------------------------------
export type GuestMsg =
  | { t: 'hello'; name: string }
  | { t: 'rpc'; id: number; m: string; p: any }
  | { t: 'doc-open'; rel: string }
  | { t: 'doc-close'; rel: string }
  | { t: 'doc-update'; rel: string; u: string }
  | { t: 'doc-save'; rel: string }
  | ({ t: 'presence' } & Presence)
  | { t: 'chat'; text: string };

export interface SessionInfo {
  sid: string;
  project: string;
  you: Peer;
  peers: Peer[];
  presence: Record<string, Presence>;
  chat: ChatMessage[];
  interpreters: Interpreter[];
}

export type HostMsg =
  | ({ t: 'session' } & SessionInfo)
  | { t: 'rpc-res'; id: number; ok: boolean; v?: any; e?: string }
  | { t: 'doc-state'; rel: string; u: string }
  | { t: 'doc-update'; rel: string; u: string }
  | { t: 'doc-saved'; rel: string }
  | { t: 'peer'; peer: Peer }
  | { t: 'peer-left'; id: string }
  | ({ t: 'presence'; id: string } & Presence)
  | ({ t: 'chat' } & ChatMessage)
  | { t: 'role'; role: Role }
  | { t: 'kev'; ev: KernelEvent }
  | { t: 'exec'; lang: Lang; msgId: string; code: string; by: string }
  | { t: 'fs'; rels: string[] }
  | { t: 'end'; reason: string };

// --- Encoding ------------------------------------------------------------------
export function toBase64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b: string): Uint8Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

/** Display names: trimmed, single line, bounded. */
export function cleanName(name: string, fallback = 'Guest'): string {
  const n = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || fallback;
}

/** Project-relative path a guest may address (no absolute paths, no "..", no backslashes). */
export function safeRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.length > 4096) return null;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return null;
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) return null;
  return parts.join('/');
}
