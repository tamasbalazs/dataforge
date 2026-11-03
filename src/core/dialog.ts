/** Promise-based modal dialogs (confirm / choice). Rendered by <DialogHost/>. */
import { create } from 'zustand';

export interface DialogButton<T extends string = string> {
  id: T;
  label: string;
  variant?: 'primary' | 'danger' | 'ghost';
}

export interface DialogRequest {
  id: number;
  title: string;
  body?: string;
  buttons: DialogButton[];
  resolve: (choice: string | null) => void;
}

export const useDialogs = create<{ current: DialogRequest | null }>(() => ({ current: null }));

let seq = 0;

export function ask<T extends string>(title: string, body: string | undefined, buttons: DialogButton<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    useDialogs.setState({
      current: {
        id: ++seq,
        title,
        body,
        buttons,
        resolve: (c) => {
          useDialogs.setState({ current: null });
          resolve(c as T | null);
        },
      },
    });
  });
}
