import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules', 'data', 'test-results', 'release-output'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Packaging refuses a symbolic link: ${path}`);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

// Classic ZIP with UTF-8 names, deflate, CRC-32 and explicit Unix modes.
// Archive tooling belongs to development/release, never the runtime server.
function archive(path, entries) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, bytes, executable } of entries) {
    const filename = Buffer.from(name);
    const compressed = deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    // Fixed release date makes repeated builds from identical files reproducible.
    header.writeUInt16LE(((2026 - 1980) << 9) | (10 << 5) | 1, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE((3 << 8) | 20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(0x800, 8);
    index.writeUInt16LE(8, 10);
    index.writeUInt16LE(((2026 - 1980) << 9) | (10 << 5) | 1, 14);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(compressed.length, 20);
    index.writeUInt32LE(bytes.length, 24);
    index.writeUInt16LE(filename.length, 28);
    index.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    central.push(index, filename);
    offset += header.length + filename.length + compressed.length;
  }
  if (entries.length > 65535) throw new Error('Archive entry limit exceeded.');
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, directory, end]);
  writeFileSync(path, bytes);
  return { filename: path.split(/[\\/]/).at(-1), files: entries.length, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), entries: entries.map(e => e.name) };
}

export function packageProject({ root = ROOT, output = join(ROOT, 'release-output') } = {}) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be a stable semantic version.');
  mkdirSync(output, { recursive: true });
  const outputPath = resolve(output);
  const all = files(root).sort().filter(path => {
    const outputRelative = relative(outputPath, resolve(path));
    const outsideOutput = outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative);
    return outsideOutput && relative(root, path) !== 'benchmark-result.json';
  });
  const entry = path => ({ name: `faultline/${relative(root, path).split(/[\\/]/).join('/')}`, bytes: readFileSync(path), executable: path.endsWith('.sh') });
  const source = all.filter(path => relative(root, path).split(/[\\/]/)[0] !== 'tests').map(entry);
  const tests = all.filter(path => relative(root, path).split(/[\\/]/)[0] === 'tests').map(entry);
  const web = all.filter(path => relative(root, path).split(/[\\/]/)[0] === 'showcase').map(path => ({ ...entry(path), name: relative(join(root, 'showcase'), path).split(/[\\/]/).join('/') }));
  if (source.some(e => e.name.includes('/tests/')) || tests.some(e => !e.name.startsWith('faultline/tests/'))) throw new Error('Source/test packaging boundary violated.');
  if (!source.some(e => e.name === 'faultline/src/server.mjs') || !source.some(e => e.name === 'faultline/public/app.mjs')) throw new Error('Source must contain both backend and frontend.');
  const records = [archive(join(output, `faultline-source-v${version}.zip`), source), archive(join(output, `faultline-tests-v${version}.zip`), tests), archive(join(output, `faultline-web-v${version}.zip`), web)];
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify({ version, commit: process.env.FAULTLINE_COMMIT ?? null, packages: records }, null, 2)}\n`);
  writeFileSync(join(output, 'SHA256SUMS.txt'), `${records.map(r => `${r.sha256}  ${r.filename}`).join('\n')}\n`);
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const records = packageProject({ output: process.argv[2] ? resolve(process.argv[2]) : undefined });
  console.log(JSON.stringify(records.map(({ entries, ...summary }) => summary), null, 2));
}
