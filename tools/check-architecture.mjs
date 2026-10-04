import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const walk = (path) =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
  );
const files = walk(join(root, 'src')).filter((path) => path.endsWith('.ts'));
const edges = new Map();
const failures = [];
for (const path of files) {
  const name = relative(root, path).replaceAll('\\', '/');
  const text = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const dependencies = [];
  if (/@ts-(?:ignore|nocheck|expect-error)/u.test(text))
    failures.push(`${name}: type checking may not be suppressed`);
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) failures.push(`${name}: explicit any is forbidden`);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = node.moduleSpecifier.text;
      if (name.startsWith('src/storage/') && /services|queue|server|worker/u.test(target))
        failures.push(`${name}: storage depends on an application service`);
      if (name.startsWith('src/domain/') && /storage|services|queue|server|worker/u.test(target))
        failures.push(`${name}: domain depends on infrastructure`);
      if (name.startsWith('src/services/') && /(?:^|\/)(?:queue|server|worker)\.ts$/u.test(target))
        failures.push(`${name}: service depends on an entry point`);
      if (!node.importClause?.isTypeOnly && target.startsWith('.'))
        dependencies.push(resolve(dirname(path), target));
    }
    if (
      name === 'src/queue.ts' &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/u.test(node.text)
    )
      failures.push(`${name}: SQL belongs to storage/services`);
    if (
      name !== 'src/storage/sqlite-store.ts' &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /\b(?:BEGIN IMMEDIATE|ROLLBACK|COMMIT)\b/u.test(node.text)
    )
      failures.push(`${name}: transaction ownership escaped SqliteStore`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  edges.set(
    path,
    dependencies.filter((path) => path.endsWith('.ts')),
  );
}
const visited = new Set(),
  active = new Set();
function visit(path) {
  if (active.has(path)) {
    failures.push(`Runtime dependency cycle: ${relative(root, path)}`);
    return;
  }
  if (visited.has(path)) return;
  active.add(path);
  for (const target of edges.get(path) ?? []) visit(target);
  active.delete(path);
  visited.add(path);
}
for (const path of files) visit(path);
if (readFileSync(join(root, 'src/queue.ts')).length > 8000)
  failures.push('Queue facade exceeded its 8 KB responsibility budget');
if (failures.length) throw new Error(failures.join('\n'));
console.log(
  `Architecture: ${files.length} typed modules; no runtime cycles, layer violations, explicit any or distributed transaction ownership.`,
);
