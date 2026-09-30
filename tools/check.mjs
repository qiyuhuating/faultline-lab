import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
}
let checked = 0;
for (const folder of ['src', 'public', 'tools', 'tests']) {
  let files;
  try { files = walk(join(root, folder)); } catch { continue; }
  for (const path of files.filter(path => path.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${path}\n${result.stderr}`);
    checked++;
  }
}
const frontend = readFileSync(join(root, 'public/app.mjs'), 'utf8');
if (/\.innerHTML\s*=|insertAdjacentHTML|\beval\(/.test(frontend)) throw new Error('Unsafe frontend sink.');
console.log(`Syntax checked: ${checked} modules; frontend uses DOM text nodes.`);
