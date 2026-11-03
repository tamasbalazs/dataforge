import { describe, expect, it } from 'vitest';
import {
  conflictFiles,
  findConflicts,
  parseBranches,
  parseLog,
  parseNameStatus,
  parseStatus,
  relativeTime,
  resolveConflict,
  stagedFiles,
  unstagedFiles,
} from './gitParse';

// Captured from git 2.43 on a repo mid-merge (rename, staged+modified, conflict, untracked, non-ASCII path).
const STATUS =
  '# branch.oid c0c6e854fab1d0a5f08b564fc366454c36d6b8e5\x00# branch.head main\x00# branch.upstream origin/main\x00# branch.ab +1 -0\x00' +
  '2 R. N... 100644 100644 100644 587be6b 587be6b R100 new.txt\x00old.txt\x00' +
  '1 AM N... 000000 100644 100644 0000000 19d9cc8 st.txt\x00' +
  '1 .M N... 100644 100644 100644 d00491f d00491f szóköz fájl.R\x00' +
  'u UU N... 100644 100644 100644 100644 de98044 af70335 6c184ee conf.txt\x00' +
  '? uj.py\x00';

describe('git status', () => {
  it('parses branch, upstream and every kind of entry', () => {
    const s = parseStatus(STATUS);
    expect([s.branch, s.upstream, s.ahead, s.behind]).toEqual(['main', 'origin/main', 1, 0]);
    expect(s.files.map((f) => f.path)).toEqual(['conf.txt', 'new.txt', 'st.txt', 'szóköz fájl.R', 'uj.py']);
    expect(s.files.find((f) => f.path === 'new.txt')).toMatchObject({ origPath: 'old.txt', index: 'R', worktree: null });
    expect(stagedFiles(s).map((f) => f.path)).toEqual(['new.txt', 'st.txt']);
    expect(unstagedFiles(s).map((f) => f.path)).toEqual(['st.txt', 'szóköz fájl.R', 'uj.py']);
    expect(conflictFiles(s).map((f) => f.path)).toEqual(['conf.txt']);
  });

  it('handles a fresh repository and a detached HEAD', () => {
    expect(parseStatus('# branch.oid (initial)\x00# branch.head main\x00')).toMatchObject({ oid: null, branch: 'main', files: [] });
    expect(parseStatus('# branch.oid abc\x00# branch.head (detached)\x00').branch).toBeNull();
  });
});

describe('git log, branches, commits', () => {
  it('parses log records', () => {
    const log = parseLog(
      'c0c6e85\x1fc0c6e85\x1fcbd1d20\x1fTeszt\x1ft@e.st\x1f1793366601\x1fHEAD -> main, tag: v1\x1fmain változás\x1e\n' +
        'cbd1d20\x1fcbd1d20\x1f\x1fTeszt\x1ft@e.st\x1f1793366600\x1forigin/main\x1felső commit\x1e\n',
    );
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ short: 'c0c6e85', parents: ['cbd1d20'], refs: ['main', 'tag: v1'], subject: 'main változás' });
    expect(log[1].parents).toEqual([]);
  });

  it('parses branches, current first, without remote HEAD', () => {
    const b = parseBranches(
      'refs/heads/feature\x1ffeature\x1fa34a8b5\x1f\x1f \x1f1793366601\nrefs/heads/main\x1fmain\x1fc0c6e85\x1forigin/main\x1f*\x1f1793366601\n' +
        'refs/remotes/origin/HEAD\x1forigin/HEAD\x1fcbd1d20\x1f\x1f \x1f1\nrefs/remotes/origin/main\x1forigin/main\x1fcbd1d20\x1f\x1f \x1f1793366600\n',
    );
    expect(b.map((x) => [x.name, x.current, x.remote])).toEqual([
      ['main', true, false],
      ['feature', false, false],
      ['origin/main', false, true],
    ]);
    expect(b[0].upstream).toBe('origin/main');
  });

  it('parses name-status with renames', () => {
    expect(parseNameStatus('M\ta.R\nR087\told.py\tnew.py\nA\tszóköz fájl.R\n')).toEqual([
      { status: 'M', path: 'a.R' },
      { status: 'R', path: 'new.py', origPath: 'old.py' },
      { status: 'A', path: 'szóköz fájl.R' },
    ]);
  });

  it('formats relative times', () => {
    const now = 1_800_000_000_000;
    expect(relativeTime(now / 1000 - 120, 'en', now)).toBe('2 minutes ago');
    expect(relativeTime(now / 1000 - 3 * 86400, 'hu', now)).toBe('3 nappal ezelőtt');
  });
});

describe('merge conflicts', () => {
  const text = ['a', '<<<<<<< HEAD', 'MAIN', '=======', 'FEATURE', '>>>>>>> feature', 'c', '<<<<<<< ours', 'x', '||||||| base', 'o', '=======', 'y', '>>>>>>> theirs'];

  it('finds blocks, including diff3 style', () => {
    const cs = findConflicts(text);
    expect(cs.map((c) => [c.start, c.base, c.sep, c.end, c.current, c.incoming])).toEqual([
      [1, null, 3, 5, 'HEAD', 'feature'],
      [7, 9, 11, 13, 'ours', 'theirs'],
    ]);
  });

  it('resolves a block with either side or both', () => {
    const [c1, c2] = findConflicts(text);
    expect(resolveConflict(text, c1, 'current').slice(0, 3)).toEqual(['a', 'MAIN', 'c']);
    expect(resolveConflict(text, c1, 'incoming').slice(0, 3)).toEqual(['a', 'FEATURE', 'c']);
    expect(resolveConflict(text, c2, 'both').slice(-2)).toEqual(['x', 'y']);
  });
});
