// The npm package @jumperly/helper (npm/): the local helper bundled into one CommonJS file with a
// shebang, so `npx @jumperly/helper` runs it with the user's `node` and installs nothing else.
//
//   pnpm build:npm
//   → npm/dist/jumperly-helper.cjs, npm/dist/THIRD-PARTY-NOTICES.txt, npm/LICENSE
//   cd npm && npm pack        (or npm publish --access public)
//
// The bundle carries third-party code (fastify, ws, zod, …): their license texts go into
// THIRD-PARTY-NOTICES.txt, as their licenses require.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'npm');
const dist = join(pkgDir, 'dist');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
// The oldest Node the package supports (`engines.node` of npm/package.json, ">=22").
const nodeMajor = /\d+/.exec(pkg.engines.node)?.[0];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src/helper.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${nodeMajor}`,
  outfile: join(dist, 'jumperly-helper.cjs'),
  banner: { js: '#!/usr/bin/env node' },
  define: { HELPER_VERSION: JSON.stringify(pkg.version) },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

copyFileSync(join(root, 'LICENSE'), join(pkgDir, 'LICENSE'));
writeFileSync(join(dist, 'THIRD-PARTY-NOTICES.txt'), notices(Object.keys(result.metafile.inputs)));
console.log(`wrote ${join('npm', 'dist', 'jumperly-helper.cjs')} (${pkg.name}@${pkg.version})`);

/** The license texts of every package in the bundle, one section per package. */
function notices(inputs) {
  const dirs = new Set();
  for (const input of inputs) {
    const path = join(root, input);
    const at = path.lastIndexOf(`${sep}node_modules${sep}`);
    if (at < 0) continue;
    const rest = path.slice(at + 14).split(sep);
    const name = rest[0]?.startsWith('@') ? `${rest[0]}${sep}${rest[1]}` : rest[0];
    if (name) dirs.add(path.slice(0, at + 14) + name);
  }
  const sections = [];
  for (const dir of [...dirs].sort()) {
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // Workspace packages (@jumperly/*) are this project's own code: covered by LICENSE.
    if (meta.name.startsWith('@jumperly/')) continue;
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    if (!file && !meta.license) throw new Error(`no license found for ${meta.name}`);
    const text = file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${meta.license}`;
    sections.push(`${meta.name}@${meta.version} (${meta.license ?? 'see below'})\n\n${text}`);
  }
  const head = `${pkg.name} bundles the following third-party packages.\n`;
  return `${head}\n${sections.map((s) => `${'='.repeat(78)}\n${s}\n`).join('\n')}`;
}
