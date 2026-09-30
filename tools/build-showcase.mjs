import { mkdirSync, copyFileSync } from 'node:fs';
const target = new URL('../showcase/', import.meta.url);
mkdirSync(target, { recursive: true });
for (const file of ['proof.mjs', 'evidence.mjs', 'favicon.svg']) copyFileSync(new URL(`../public/${file}`, import.meta.url), new URL(file, target));
console.log('Showcase shared modules copied from their canonical sources.');
