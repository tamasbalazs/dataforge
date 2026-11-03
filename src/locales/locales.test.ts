import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from './en.json';
import hu from './hu.json';

function keys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}

describe('locales', () => {
  it('Hungarian and English have exactly the same keys', () => {
    expect(keys(hu).sort()).toEqual(keys(en).sort());
  });

  it('every statically referenced key exists', () => {
    const all = new Set(keys(en).map((k) => k.replace(/_(one|other)$/, '')));
    const missing: string[] = [];
    const root = join(__dirname, '..');
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8');
      // t('a.b'), title: 'a.b', category: 'a.b'
      for (const m of src.matchAll(/(?:\bt|\btt)\(\s*'([a-z][\w]*(?:\.[\w]+)+)'|(?:title|category):\s*'([a-z][\w]*\.[\w.]+)'/g)) {
        const key = m[1] ?? m[2];
        if (!all.has(key)) missing.push(`${key} (${file.replace(root, 'src')})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('interpolation placeholders match between languages', () => {
    const flat = (o: Record<string, unknown>) => Object.fromEntries(keys(o).map((k) => [k, k.split('.').reduce<any>((a, p) => a[p], o)]));
    const fe = flat(en);
    const fh = flat(hu);
    const vars = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(fe)) expect([k, vars(fh[k])]).toEqual([k, vars(fe[k])]);
  });
});
