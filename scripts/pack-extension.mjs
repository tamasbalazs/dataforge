#!/usr/bin/env node
// Packs an extension folder into a .dfext file (a zip; files stored uncompressed).
// Usage: node scripts/pack-extension.mjs <folder> [out.dfext]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { crc32 } from 'node:zlib';

const dir = resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(readFileSync(join(dir, 'dataforge-extension.json'), 'utf8'));
const out = resolve(process.argv[3] ?? `${manifest.id.split('.').pop()}-${manifest.version}.dfext`);
const files = [];
const walk = (d) => {
  for (const name of readdirSync(d).sort()) {
    if (name.startsWith('.') || name === 'node_modules' || name.endsWith('.dfext')) continue;
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(dir);
const chunks = [];
const central = [];
let offset = 0;
for (const f of files) {
  const name = Buffer.from(relative(dir, f).split('\\').join('/'), 'utf8');
  const data = readFileSync(f);
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(0, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  chunks.push(local, name, data);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
  c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, name);
  offset += 30 + name.length + data.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
writeFileSync(out, Buffer.concat([...chunks, cd, end]));
console.log(`${out} (${files.length} files)`);
