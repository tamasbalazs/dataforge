/**
 * A small in-memory git repository and an echo shell for the browser mock
 * host, so the Git and Terminal panels can be developed and tested without a backend.
 */
import type { GitOutput, PtyEvent } from './host';

const ROOT = '/home/demo/projekt';
const ok = (stdout = ''): GitOutput => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): GitOutput => ({ code, stdout: '', stderr });

interface MockCommit {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  date: number;
  files: Array<[string, string]>;
  tree: Map<string, string>;
}

export function createMockGit(files: Map<string, string>) {
  const rel = (p: string) => p.slice(ROOT.length + 1);
  const worktree = () => new Map([...files].filter(([p]) => p.startsWith(ROOT + '/')).map(([p, c]) => [rel(p), c]));
  // HEAD: the project as it is, minus the report (untracked) and with an older analysis.R (modified).
  const head = worktree();
  head.delete('report.qmd');
  head.set('analysis.R', 'library(stats)\n');
  const index = new Map(head);
  const hash = () => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const now = Math.floor(Date.now() / 1000);
  const c1: MockCommit = { hash: hash(), parents: [], subject: 'Projekt létrehozása', author: 'Demo', date: now - 86400 * 3, files: [...head.keys()].map((p) => ['A', p]), tree: new Map(head) };
  const commits: MockCommit[] = [c1];
  let branch = 'main';
  const branches = new Map<string, string>([['main', c1.hash], ['feature/plots', c1.hash]]);
  let ahead = 0;

  const diffCode = (a: Map<string, string>, b: Map<string, string>, p: string) =>
    !a.has(p) && b.has(p) ? 'A' : a.has(p) && !b.has(p) ? 'D' : a.get(p) !== b.get(p) ? 'M' : '.';

  function status(): string {
    const wt = worktree();
    const out = [`# branch.oid ${commits[0].hash}`, `# branch.head ${branch}`];
    if (branch === 'main') out.push('# branch.upstream origin/main', `# branch.ab +${ahead} -0`);
    const paths = new Set([...head.keys(), ...index.keys(), ...wt.keys()]);
    for (const p of [...paths].sort()) {
      if (!head.has(p) && !index.has(p)) {
        out.push(`? ${p}`);
        continue;
      }
      const x = diffCode(head, index, p);
      const y = diffCode(index, wt, p);
      if (x !== '.' || y !== '.') out.push(`1 ${x}${y} N... 100644 100644 100644 0000000 0000000 ${p}`);
    }
    return out.join('\0') + '\0';
  }

  function pathsAfterDashes(args: string[]) {
    const i = args.indexOf('--');
    return i >= 0 ? args.slice(i + 1) : [];
  }

  function exec(root: string, args: string[], stdin?: string | null): GitOutput {
    if (!root.startsWith(ROOT)) return fail('fatal: not a git repository (or any of the parent directories): .git', 128);
    const [sub, ...rest] = args;
    const wt = worktree();
    switch (sub) {
      case 'rev-parse':
        if (rest.includes('--show-toplevel')) return ok(ROOT + '\n');
        if (rest.includes('--is-inside-work-tree')) return ok('true\n');
        if (rest.includes('--abbrev-ref')) return ok(branch + '\n');
        if (rest[0] === 'HEAD') return ok(commits[0].hash + '\n');
        return fail('', 1); // no MERGE_HEAD
      case 'status':
        if (!rest.some((a) => a.startsWith('--porcelain=v2'))) {
          // v1 short format: "XY path"
          return ok(status().split('\0').filter((l) => l.startsWith('1 ') || l.startsWith('? ')).map((l) => (l.startsWith('? ') ? `?? ${l.slice(2)}` : `${l.slice(2, 4).replace(/\./g, ' ')} ${l.split(' ').slice(8).join(' ')}`)).join('\0') + '\0');
        }
        return ok(status());
      case 'add': {
        const ps = pathsAfterDashes(rest);
        for (const p of ps.length ? ps : [...new Set([...wt.keys(), ...index.keys()])]) {
          if (wt.has(p)) index.set(p, wt.get(p)!);
          else index.delete(p);
        }
        return ok();
      }
      case 'restore': {
        const ps = pathsAfterDashes(rest);
        for (const p of ps) {
          if (rest.includes('--staged')) {
            if (head.has(p)) index.set(p, head.get(p)!);
            else index.delete(p);
          } else if (index.has(p)) files.set(`${ROOT}/${p}`, index.get(p)!);
        }
        return ok();
      }
      case 'reset':
        index.clear();
        head.forEach((v, k) => index.set(k, v));
        return ok();
      case 'commit': {
        const changed = [...new Set([...head.keys(), ...index.keys()])].filter((p) => diffCode(head, index, p) !== '.');
        if (!changed.length) return { code: 1, stdout: 'nothing to commit, working tree clean\n', stderr: '' };
        const c: MockCommit = {
          hash: hash(),
          parents: [commits[0].hash],
          subject: (stdin ?? 'Merge').trim().split('\n')[0],
          author: 'Demo',
          date: Math.floor(Date.now() / 1000),
          files: changed.map((p) => [diffCode(head, index, p), p]),
          tree: new Map(index),
        };
        commits.unshift(c);
        head.clear();
        index.forEach((v, k) => head.set(k, v));
        branches.set(branch, c.hash);
        if (branch === 'main') ahead++;
        return ok(`[${branch} ${c.hash.slice(0, 7)}] ${c.subject}\n`);
      }
      case 'log':
        return ok(
          commits
            .map((c, i) => {
              const refs = [i === 0 ? `HEAD -> ${branch}` : '', c.hash === commits[ahead]?.hash && branch === 'main' ? 'origin/main' : ''].filter(Boolean).join(', ');
              return [c.hash, c.hash.slice(0, 7), c.parents.join(' '), c.author, 'demo@example.com', c.date, refs, c.subject].join('\x1f') + '\x1e\n';
            })
            .join(''),
        );
      case 'for-each-ref':
        return ok(
          [...branches]
            .map(([n, h]) => [`refs/heads/${n}`, n, h.slice(0, 7), n === 'main' ? 'origin/main' : '', n === branch ? '*' : ' ', now].join('\x1f'))
            .concat([['refs/remotes/origin/main', 'origin/main', c1.hash.slice(0, 7), '', ' ', now - 100].join('\x1f')])
            .join('\n') + '\n',
        );
      case 'switch': {
        const name = rest[rest.length - 1];
        if (rest[0] === '-c') branches.set(rest[1], commits[0].hash);
        else if (!branches.has(name)) return fail(`fatal: invalid reference: ${name}`, 128);
        branch = rest[0] === '-c' ? rest[1] : name;
        return ok();
      }
      case 'show': {
        if (rest.includes('--name-status')) {
          const c = commits.find((x) => x.hash === rest[rest.length - 1]);
          return ok(c ? c.files.map(([s, p]) => `${s}\t${p}`).join('\n') + '\n' : '');
        }
        const spec = rest[0];
        const [rev, p] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
        const tree = rev === '' ? index : rev === 'HEAD' ? head : commits.find((c) => c.hash.startsWith(rev))?.tree;
        return tree?.has(p) ? ok(tree.get(p)!) : fail(`fatal: path '${p}' does not exist in '${rev || 'index'}'`, 128);
      }
      case 'push':
        ahead = 0;
        return ok();
      case 'pull':
      case 'fetch':
      case 'merge':
      case 'init':
        return ok();
      case 'remote':
        return ok('origin\n');
      default:
        return fail(`git ${sub}: not supported by the mock`, 1);
    }
  }
  return { exec };
}

/** An echo "shell": enough to type commands and see output in the browser preview. */
export function createMockShell(files: Map<string, string>, emit: (ev: PtyEvent) => void) {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const lines = new Map<string, string>();
  const prompt = '\x1b[1;32mdemo@dataforge\x1b[0m:\x1b[1;34m~/projekt\x1b[0m$ ';
  const out = (id: string, s: string) => emit({ id, data: b64(s), exit: null });
  return {
    open(id: string) {
      lines.set(id, '');
      setTimeout(() => out(id, `DataForge mock shell — ${new Date().toLocaleString()}\r\n${prompt}`), 50);
      return 'bash';
    },
    write(id: string, data: string) {
      for (const ch of data) {
        const line = lines.get(id) ?? '';
        if (ch === '\r') {
          lines.set(id, '');
          const cmd = line.trim();
          let res = '';
          if (cmd === 'ls') res = [...files.keys()].filter((p) => p.startsWith(ROOT + '/') && !p.slice(ROOT.length + 1).includes('/')).map((p) => p.slice(ROOT.length + 1)).join('  ') + '\r\n';
          else if (cmd === 'pwd') res = ROOT + '\r\n';
          else if (cmd === 'exit') {
            emit({ id, data: b64('logout\r\n'), exit: null });
            setTimeout(() => emit({ id, data: '', exit: 0 }), 20);
            return;
          } else if (cmd) res = `mock: ${cmd}: ok\r\n`;
          out(id, `\r\n${res}${prompt}`);
        } else if (ch === '\x7f') {
          if (line) {
            lines.set(id, line.slice(0, -1));
            out(id, '\b \b');
          }
        } else if (ch >= ' ') {
          lines.set(id, line + ch);
          out(id, ch);
        }
      }
    },
  };
}
