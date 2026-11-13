// Checks the npm tarball before publishing: the plugin entry and every
// module it imports must ship, and repository tooling must not. Run with
// `npm run verify:package` (prepublishOnly runs it too).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

function fail(message) {
  console.error(`package verification failed: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.exports?.['./server'] !== './index.ts') fail("exports['./server'] must be ./index.ts");
if (typeof pkg.engines?.opencode !== 'string') fail('engines.opencode must declare the supported opencode range');
if (pkg.dependencies?.['@opencode-ai/plugin']) fail('@opencode-ai/plugin belongs in peerDependencies, not dependencies');

const [report] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const files = new Set(report.files.map((f) => f.path));

const required = ['package.json', 'index.ts', 'README.md', 'CHANGELOG.md', 'LICENSE'];
for (const name of readdirSync('src')) if (name.endsWith('.ts')) required.push(`src/${name}`);
for (const file of required) if (!files.has(file)) fail(`missing from the tarball: ${file}`);

const forbidden = [/^\.opencode\//, /^\.uf\//, /^\.specify\//, /^openspec\//, /^test\//, /^scripts\//, /^\.github\//, /^node_modules\//, /^bun\.lock$/, /^opencode\.json$/];
for (const file of files) if (forbidden.some((re) => re.test(file))) fail(`should not ship: ${file}`);

// Every relative import in shipped .ts files must resolve to a shipped file.
for (const file of files) {
  if (!file.endsWith('.ts')) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    const target = new URL(m[1], `file:///${file}`).pathname.slice(1);
    if (!files.has(target)) fail(`${file} imports ${m[1]}, which is not in the tarball`);
  }
}

console.log(`package ok: ${report.name}@${report.version}, ${files.size} files, ${report.size} bytes packed`);
