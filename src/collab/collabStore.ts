/** Collaboration state shown by the UI (kept free of imports, so any module can read it). */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatMessage, Peer, Presence, Role } from './protocol';

export type CollabStatus = 'off' | 'starting' | 'hosting' | 'joining' | 'joined';

export interface CollabState {
  status: CollabStatus;
  error: string | null;
  me: Peer | null;
  /** Everyone else in the session (the host included, for guests). */
  peers: Peer[];
  presence: Record<string, Presence>;
  chat: ChatMessage[];
  unread: number;
  /** Host: invitation link and where the relay listens. */
  invitation: string | null;
  addresses: string[];
  lan: boolean;
  /** Guest: the shared project's name and session id. */
  project: string | null;
  sid: string | null;
  /** Peer whose cursor this user follows. */
  follow: string | null;
}

export const useCollab = create<CollabState>(() => ({
  status: 'off',
  error: null,
  me: null,
  peers: [],
  presence: {},
  chat: [],
  unread: 0,
  invitation: null,
  addresses: [],
  lan: false,
  project: null,
  sid: null,
  follow: null,
}));

/** Remembered choices (display name, how to share). */
export const useCollabPrefs = create<{ name: string; lan: boolean; defaultRole: Role }>()(
  persist((): { name: string; lan: boolean; defaultRole: Role } => ({ name: '', lan: false, defaultRole: 'edit' }), { name: 'dataforge.collab' }),
);

export const inSession = () => {
  const s = useCollab.getState().status;
  return s === 'hosting' || s === 'joined';
};
