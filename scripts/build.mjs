#!/usr/bin/env node
/**
 * Build script for standalone-claw.
 *
 * Build pipeline:
 *   1. esbuild bundles openclaw's dist files (node_modules/openclaw/dist/entry.js)
 *      together with all npm dependencies (except native/binary packages) into a
 *      single CJS file (src/openclaw-bundle.cjs).  Bundling npm deps inline avoids
 *      ESM-only packages (chalk, @mariozechner/pi-ai, etc.) being left as external
 *      require() calls which would fail because they have no CJS exports.
 *
 *   2. A post-processing step patches two esbuild CJS quirks:
 *      - __toESM: when isNodeMode=1 and the module has __esModule+default, use
 *        mod.default as the default export (fixes chalk and similar ESM-only pkgs).
 *      - import.meta (import_metaN = {}): replaced with a proper object whose .url
 *        property equals the bundle file's URL, satisfying openclaw's isMainModule()
 *        guard that compares import.meta.url with process.argv[1].
 *
 *   3. @yao-pkg/pkg wraps src/main.cjs (which requires the bundle) together with
 *      the Node.js runtime into a self-contained executable.  External native
 *      packages (.node addons) are extracted to a temp directory at first run.
 *
 * Usage:
 *   node scripts/build.mjs               # build all four platform targets
 *   node scripts/build.mjs --target win  # Windows only
 *   node scripts/build.mjs --target linux
 *   node scripts/build.mjs --target macos
 *   node scripts/build.mjs --target macos-arm64
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Parse --target flag
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const targetFilter = targetIdx !== -1 ? args[targetIdx + 1] : null;

// Node.js version requirement from openclaw: >=22.12.0
const NODE_VERSION = 'node22';

// Target triples supported by @yao-pkg/pkg
const ALL_TARGETS = [
  { name: 'win', triple: `${NODE_VERSION}-win-x64`, output: 'openclaw-win.exe' },
  { name: 'linux', triple: `${NODE_VERSION}-linux-x64`, output: 'openclaw-linux' },
  { name: 'macos', triple: `${NODE_VERSION}-macos-x64`, output: 'openclaw-macos' },
  { name: 'macos-arm64', triple: `${NODE_VERSION}-macos-arm64`, output: 'openclaw-macos-arm64' },
];

const targets = targetFilter
  ? ALL_TARGETS.filter((t) => t.name === targetFilter)
  : ALL_TARGETS;

if (targets.length === 0) {
  process.stderr.write(
    `Unknown target "${targetFilter}". Valid targets: ${ALL_TARGETS.map((t) => t.name).join(', ')}\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve tool binaries
// ---------------------------------------------------------------------------
const esbuildBin = path.join(root, 'node_modules', '.bin', 'esbuild');
const pkgBin = path.join(root, 'node_modules', '.bin', 'pkg');

for (const [name, bin] of [['esbuild', esbuildBin], ['pkg', pkgBin]]) {
  if (!existsSync(bin)) {
    process.stderr.write(`${name} binary not found. Run \`npm install\` first.\n`);
    process.exit(1);
  }
}

// Ensure dist/ exists
await mkdir(path.join(root, 'dist'), { recursive: true });

// ---------------------------------------------------------------------------
// Step 1: Bundle openclaw + npm deps to a single CJS module with esbuild.
//
// Packages marked as external are either:
//   - Native binary addons (contain .node files) that must be loaded from disk
//   - Packages with top-level await or other CJS-incompatible constructs
//
// NOTE: We intentionally do NOT use --external:"*.node" here because that
// glob also matches JavaScript files whose names happen to end in ".node"
// (e.g. grammy's platform.node.js), causing incorrect externalization.
// ---------------------------------------------------------------------------
const bundlePath = path.join(root, 'src', 'openclaw-bundle.cjs');
const openclawEntry = path.join(root, 'node_modules', 'openclaw', 'dist', 'entry.js');

console.log('\nStep 1: Bundling openclaw + npm deps with esbuild…');
execFileSync(
  esbuildBin,
  [
    openclawEntry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${bundlePath}`,
    '--log-level=warning',
    // Native binary addon packages — must be loaded from real filesystem
    '--external:@img/*',
    '--external:@lydell/*',
    '--external:@mariozechner/clipboard-*',
    '--external:@napi-rs/*',
    '--external:@node-llama-cpp',
    '--external:@node-llama-cpp/*',
    '--external:@reflink/*',
    '--external:@snazzah/*',
    '--external:koffi',
    // node-llama-cpp main package uses top-level await (cannot bundle to CJS)
    '--external:node-llama-cpp',
    // Optional media / voice packages not required for core gateway
    '--external:ffmpeg-static',
    '--external:opusscript',
    '--external:@discordjs/opus',
    '--external:sodium-native',
    // playwright-core requires chromium-bidi which is not installed
    '--external:playwright',
    '--external:playwright-core',
    '--external:chromium-bidi',
    '--external:chromium-bidi/*',
  ],
  { stdio: 'inherit', cwd: root }
);

// ---------------------------------------------------------------------------
// Step 2: Post-process the bundle to fix two esbuild CJS quirks.
// ---------------------------------------------------------------------------
console.log('\nStep 2: Post-processing bundle…');

let bundle = readFileSync(bundlePath, 'utf8');

// Fix 2a — __toESM interop for ESM-only packages.
// When isNodeMode=1 esbuild sets target.default = mod (the whole module).
// For ESM packages (mod.__esModule === true, mod.default !== undefined) we
// want target.default = mod.default instead.
// Use a regex because esbuild may rename the parameter (mod, mod6, etc.)
const toEsmRegex = /var __toESM = \((\w+), isNodeMode, target\) => \(target = \1 != null \? __create\(__getProtoOf\(\1\)\) : \{\}, __copyProps\(\n  \/\/ If the importer is in node compatibility mode or this is not an ESM[\s\S]*?\n  isNodeMode \|\| !\1 \|\| !\1\.__esModule \? __defProp\(target, "default", \{ value: \1, enumerable: true \}\) : target,\n  \1\n\)\);/;

const toEsmMatch = bundle.match(toEsmRegex);
if (!toEsmMatch) {
  process.stderr.write('WARNING: Could not find __toESM to patch — esbuild output may have changed.\n');
} else {
  const modParam = toEsmMatch[1]; // captured parameter name (mod, mod6, etc.)
  bundle = bundle.replace(toEsmRegex,
    `var __toESM = (${modParam}, isNodeMode, target) => (target = ${modParam} != null ? __create(__getProtoOf(${modParam})) : {}, __copyProps(\n  // If in node compatibility mode AND the module is ESM (has __esModule) AND\n  // has a .default, use .default so ESM-only packages (e.g. chalk) are\n  // correctly unwrapped when required from CJS context.\n  isNodeMode && ${modParam} && ${modParam}.__esModule && ${modParam}.default !== void 0 ? __defProp(target, "default", { value: ${modParam}.default, enumerable: true }) : isNodeMode || !${modParam} || !${modParam}.__esModule ? __defProp(target, "default", { value: ${modParam}, enumerable: true }) : target,\n  ${modParam}\n));`
  );
  console.log('  ✓ Patched __toESM for ESM default-export interop.');
}

// Fix 2b — import.meta.url replacement.
// esbuild replaces import.meta with an empty object {} in CJS output.
// openclaw's isMainModule() guard compares import.meta.url with process.argv[1];
// without a url property the check returns false and the CLI never runs.
const importMetaCount = (bundle.match(/import_meta\d* = \{\}/g) || []).length;
bundle = bundle.replace(
  /import_meta(\d*) = \{\}/g,
  'import_meta$1 = { url: require("node:url").pathToFileURL(__filename).href }',
);
console.log(`  ✓ Patched ${importMetaCount} import.meta instance(s) with __filename-based URL.`);

writeFileSync(bundlePath, bundle, 'utf8');
console.log(`Bundle written: src/openclaw-bundle.cjs (${(bundle.length / 1024 / 1024).toFixed(1)} MB)`);

// ---------------------------------------------------------------------------
// Step 3: Build each target executable with pkg
// ---------------------------------------------------------------------------
for (const target of targets) {
  const outputPath = path.join(root, 'dist', target.output);

  console.log(`\nStep 3 [${target.name}]: Packaging with pkg → dist/${target.output} …`);

  execFileSync(
    pkgBin,
    [
      path.join(root, 'src', 'main.cjs'),
      '--target', target.triple,
      '--output', outputPath,
      // Keep JS source as plain text so CJS require() resolution works
      // correctly at runtime for external packages inside the snapshot.
      '--no-bytecode',
      // Expose all package sources (required for openclaw's runtime introspection).
      '--public-packages', '*',
      '--public',
    ],
    { stdio: 'inherit', cwd: root }
  );

  console.log(`Built: dist/${target.output}`);
}

console.log('\nAll builds complete.');


