import { describe, expect, it } from 'vitest';
import { baseName, dirName, formatRemote, isRemotePath, kernelPath, parseRemote, rootLabel, workspacePath } from './paths';

describe('workspace paths', () => {
  it('parses remote paths', () => {
    expect(parseRemote('ssh://lab/home/ana/p')).toEqual({ id: 'lab', path: '/home/ana/p' });
    expect(parseRemote('ssh://lab')).toEqual({ id: 'lab', path: '/' });
    expect(parseRemote('ssh://lab//home//ana/')).toEqual({ id: 'lab', path: '/home/ana' });
    expect(parseRemote('/home/ana')).toBeNull();
    expect(parseRemote('ssh:///x')).toBeNull();
    expect(isRemotePath('ssh://x/y')).toBe(true);
    expect(isRemotePath(null)).toBe(false);
    expect(formatRemote('lab', 'home/a')).toBe('ssh://lab/home/a');
  });

  it('converts between workspace and kernel paths', () => {
    expect(kernelPath('ssh://lab/home/ana/a.R')).toBe('/home/ana/a.R');
    expect(kernelPath('/local/a.R')).toBe('/local/a.R');
    expect(workspacePath('/home/ana/a.py', 'ssh://lab/home/ana')).toBe('ssh://lab/home/ana/a.py');
    expect(workspacePath('/home/ana/a.py', '/home/ana')).toBe('/home/ana/a.py');
    expect(workspacePath('<ipython-input-1>', 'ssh://lab/x')).toBe('<ipython-input-1>');
  });

  it('names and parents stay on the same host', () => {
    expect(baseName('ssh://lab/home/ana/a.R')).toBe('a.R');
    expect(dirName('ssh://lab/home/ana/a.R')).toBe('ssh://lab/home/ana');
    expect(dirName('ssh://lab/home')).toBe('ssh://lab/');
    expect(dirName('/home/ana/a.R')).toBe('/home/ana');
    expect(rootLabel('ssh://lab/home/ana/klaszter', 'Lab GPU')).toBe('klaszter · Lab GPU');
    expect(rootLabel('/home/ana/p')).toBe('p');
  });
});
