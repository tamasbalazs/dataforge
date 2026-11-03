/** Transient UI state (open dialogs etc.). */
import { create } from 'zustand';

import type { JobDialogRequest } from '../jobs/jobDialog';

export const useUi = create<{ settingsOpen: boolean; onboardingOpen: boolean; remoteOpen: boolean; collabDialog: 'host' | 'join' | null; jobDialog: JobDialogRequest | null }>(() => ({
  settingsOpen: false,
  onboardingOpen: false,
  remoteOpen: false,
  collabDialog: null,
  jobDialog: null,
}));
