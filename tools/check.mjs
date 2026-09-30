import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function walk(path) {
  return readdirSync(path, { withFileTypes: true }).filter(entry => !['node_modules', 'evidence', '.git'].includes(entry.name)).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
}
let checked = 0;
for (const folder of ['src', 'public', 'showcase', 'tools', 'tests']) {
  let files;
  try { files = walk(join(root, folder)); } catch { continue; }
  for (const path of files.filter(path => path.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${path}\n${result.stderr}`);
    checked++;
  }
}
for (const folder of ['public', 'showcase']) for (const path of walk(join(root, folder)).filter(p => p.endsWith('.mjs'))) {
  const frontend = readFileSync(path, 'utf8');
  if (/\.innerHTML\s*=|insertAdjacentHTML|\beval\(|new Function\(/.test(frontend)) throw new Error(`Unsafe frontend sink: ${path}`);
}
console.log(`Syntax checked: ${checked} modules; frontend uses DOM text nodes.`);
