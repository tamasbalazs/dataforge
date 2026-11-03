#!/usr/bin/env node
// Collect the installers built by `tauri build` into release/<version>/,
// with SHA256SUMS, a manifest, and a detached GPG signature of the checksums.
//
//   node scripts/release.mjs [--build] [--bundles deb,rpm,appimage] [--sign] [--out dir] [--from dir]
//
// --from     collect installers from this folder instead of the Tauri bundle
//            folder (CI: the artifacts of all platforms, signed together)
// --build    run `pnpm tauri build` first (platform signing comes from the
//            environment, see docs/RELEASING.md)
// --sign     sign SHA256SUMS with GPG (key: $DATAFORGE_GPG_KEY or the default key;
//            passphrase: $DATAFORGE_GPG_PASSPHRASE, optional)
// Exits non-zero when versions disagree, nothing was built, or signing fails.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// --- versions ------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;
const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8'))?.[1];
if (!(pkg === conf && conf === cargo)) fail(`version mismatch: package.json ${pkg}, tauri.conf.json ${conf}, Cargo.toml ${cargo}`);
const version = pkg;
console.log(`▸ DataForge ${version}`);

// --- build ---------------------------------------------------------------------
if (flag('--build')) {
  const bundles = opt('--bundles');
  const r = spawnSync('pnpm', ['tauri', 'build', ...(bundles ? ['--bundles', ...bundles.split(',')] : [])], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail('tauri build failed');
}

// --- collect -------------------------------------------------------------------
const bundleDir = resolve(opt('--from') ?? join(root, 'src-tauri/target/release/bundle'));
if (!existsSync(bundleDir)) fail(`no bundles in ${bundleDir} (run with --build)`);
const KINDS = [
  [/\.deb$/, 'linux', 'Debian/Ubuntu package'],
  [/\.rpm$/, 'linux', 'Fedora/RHEL package'],
  [/\.AppImage$/, 'linux', 'AppImage'],
  [/\.dmg$/, 'macos', 'disk image'],
  [/\.msi$/, 'windows', 'MSI installer'],
  [/-setup\.exe$/, 'windows', 'installer (NSIS)'],
];
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  const s = statSync(p);
  return s.isDirectory() && !n.endsWith('.app') ? walk(p) : [p];
});
const files = walk(bundleDir)
  .map((p) => ({ p, k: KINDS.find(([re]) => re.test(p)) }))
  .filter((x) => x.k && basename(x.p).includes(version));
if (!files.length) fail(`no installers for version ${version} in ${bundleDir}`);

const out = resolve(opt('--out') ?? join(root, 'release', version));
mkdirSync(out, { recursive: true });

/** Platform code-signing status where the tools exist (informational). */
function signature(path, platform) {
  const run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8' });
  if (platform === 'macos' && process.platform === 'darwin') {
    const r = run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', path]);
    const s = run('xcrun', ['stapler', 'validate', path]);
    return r.status === 0 ? (s.status === 0 ? 'signed, notarized' : 'signed') : 'unsigned';
  }
  if (platform === 'windows' && process.platform === 'win32') {
    const r = run('powershell', ['-NoProfile', '-Command', `(Get-AuthenticodeSignature '${path}').Status`]);
    return r.stdout.trim() === 'Valid' ? 'signed' : `unsigned (${r.stdout.trim() || 'unknown'})`;
  }
  return platform === 'linux' ? 'covered by SHA256SUMS.asc' : 'not checked on this OS';
}

const entries = [];
for (const { p, k } of files) {
  const name = basename(p);
  if (resolve(p) !== join(out, name)) copyFileSync(p, join(out, name));
  const sha256 = createHash('sha256').update(readFileSync(p)).digest('hex');
  entries.push({ name, size: statSync(p).size, sha256, platform: k[1], kind: k[2], signature: signature(p, k[1]) });
}
entries.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(out, 'SHA256SUMS'), entries.map((e) => `${e.sha256}  ${e.name}`).join('\n') + '\n');
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ product: 'DataForge', version, created: new Date().toISOString(), files: entries }, null, 2) + '\n');

// --- sign ----------------------------------------------------------------------
if (flag('--sign')) {
  const key = process.env.DATAFORGE_GPG_KEY;
  const pass = process.env.DATAFORGE_GPG_PASSPHRASE;
  const gpgArgs = ['--batch', '--yes', '--armor', '--detach-sign', ...(key ? ['--local-user', key] : []), ...(pass ? ['--pinentry-mode', 'loopback', '--passphrase-fd', '0'] : []), '--output', join(out, 'SHA256SUMS.asc'), join(out, 'SHA256SUMS')];
  try {
    execFileSync('gpg', gpgArgs, { input: pass ?? '', stdio: ['pipe', 'inherit', 'inherit'] });
    execFileSync('gpg', ['--batch', '--verify', join(out, 'SHA256SUMS.asc'), join(out, 'SHA256SUMS')], { stdio: 'ignore' });
  } catch {
    fail('GPG signing failed (is the key available? see docs/RELEASING.md)');
  }
}

for (const e of entries) console.log(`  ${e.name}  ${(e.size / 1048576).toFixed(1)} MB  ${e.platform}  [${e.signature}]`);
console.log(`✓ ${entries.length} file(s) in ${out}${flag('--sign') ? ' (SHA256SUMS signed)' : ''}`);
