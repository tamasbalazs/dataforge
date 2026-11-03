import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventToChord, findCommandForChord, formatChord, fuzzyMatch, registerCommand, runCommand, useCommands } from './commands';
import { terminalAllows } from './commands';

const ev = (o: Partial<KeyboardEvent>) =>
  ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent;

describe('keybindings', () => {
  it('normalises chords per platform', () => {
    expect(eventToChord(ev({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+P');
    expect(eventToChord(ev({ key: 'p', code: 'KeyP', metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+P');
    expect(eventToChord(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }), false)).toBe('Mod+Enter');
    expect(eventToChord(ev({ key: '1', code: 'Digit1', altKey: true }), false)).toBe('Alt+1');
  });

  it('formats chords for display', () => {
    expect(formatChord('Mod+Shift+P', true)).toEqual(['⌘', '⇧', 'P']);
    expect(formatChord('Mod+Enter', false)).toEqual(['Ctrl', 'Enter']);
  });
});

describe('command registry', () => {
  beforeEach(() => useCommands.setState({ commands: {}, recent: [] }));

  it('registers, runs and tracks recent commands', async () => {
    const fn = vi.fn();
    const dispose = registerCommand({ id: 'x.run', title: 't', keybinding: 'Mod+K', run: fn });
    expect(findCommandForChord('Mod+K')?.id).toBe('x.run');
    await runCommand('x.run');
    expect(fn).toHaveBeenCalledOnce();
    expect(useCommands.getState().recent[0]).toBe('x.run');
    dispose();
    expect(findCommandForChord('Mod+K')).toBeUndefined();
  });

  it('respects when-clauses', () => {
    registerCommand({ id: 'a', title: 't', keybinding: 'Mod+J', run: () => {}, when: () => false });
    expect(findCommandForChord('Mod+J')).toBeUndefined();
  });
});

describe('fuzzyMatch', () => {
  it('matches subsequences and ranks word starts higher', () => {
    expect(fuzzyMatch('xyz', 'Run line')).toBeNull();
    const a = fuzzyMatch('rl', 'Run Line')!;
    const b = fuzzyMatch('rl', 'Clear all')!;
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.positions).toEqual([0, 4]);
  });

  it('prefers prefix matches', () => {
    expect(fuzzyMatch('the', 'Theme: dark')!.score).toBeGreaterThan(fuzzyMatch('the', 'Toggle the panel')!.score);
  });

  it('leaves shell shortcuts to the terminal', () => {
    for (const c of ['Mod+C', 'Mod+R', 'Mod+W', 'Mod+O', 'Mod+Enter']) expect(terminalAllows(c)).toBe(false);
    for (const c of ['Mod+Shift+P', 'Mod+`', 'Alt+2', 'Mod+Alt+1', 'F1']) expect(terminalAllows(c)).toBe(true);
  });
});
