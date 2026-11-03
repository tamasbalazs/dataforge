import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('vendored stanc.js', () => {
  it('matches its recorded SHA-256 (public/vendor/stanc/SHA256SUMS)', () => {
    const dir = resolve(__dirname, '../../public/vendor/stanc');
    const [hash, name] = readFileSync(resolve(dir, 'SHA256SUMS'), 'utf8').trim().split(/\s+/);
    expect(name).toBe('stanc.js');
    expect(createHash('sha256').update(readFileSync(resolve(dir, name))).digest('hex')).toBe(hash);
  });
});
