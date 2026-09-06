/**
 * Builds the API into something Node can run.
 *
 *   npm run build --workspace @neem/api
 *
 * **Why this is not `tsc`.** It was, and it had never worked. Every import in
 * this codebase carries a `.ts` extension — which is what `tsx` and Node's own
 * type stripping need — and `tsc` cannot emit those: it fails with 462
 * `TS5097` errors. It also emitted anyway, to `dist/apps/api/src/` rather than
 * `dist/`, and the JavaScript it produced still imported `.ts` paths, so even
 * run from the right place it died with `ERR_MODULE_NOT_FOUND` on its first
 * import. Three faults stacked, none of which show up in development, because
 * development never runs the build.
 *
 * esbuild rewrites the specifiers as it bundles, which removes the problem at
 * its root rather than rewriting several hundred import statements.
 *
 * **What is bundled and what is not.** Everything under `apps/api/src` and
 * `packages/contracts/src` is bundled — the contracts package is published as
 * TypeScript source with no build of its own, so it cannot be left as a
 * runtime import. Every real dependency is external and resolved from
 * `node_modules` at run time, which matters most for `@prisma/client` (it is
 * generated, and carries platform-specific query engines that must not be
 * inlined) and `@node-rs/argon2` (a native module that cannot be).
 *
 * The external list is read from `apps/api/package.json` rather than written
 * out here, so adding a dependency does not silently start bundling it.
 *
 * **Type checking is not part of this.** esbuild strips types without checking
 * them. `npm run typecheck` does that, and it runs over the same source with
 * `.ts` extensions allowed. Keeping the two separate is what lets the build
 * stop being a second, differently-configured type check that disagreed with
 * the first.
 */
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(ROOT, 'apps', 'api');

/**
 * Workspace packages are bundled; everything else is external.
 *
 * `@neem/contracts` has no build step of its own — its `main` points at
 * `src/index.ts` — so leaving it external would put a TypeScript import in the
 * emitted JavaScript, which is the same failure this build exists to fix.
 */
function externalDependencies() {
  const manifest = JSON.parse(readFileSync(path.join(API, 'package.json'), 'utf8'));
  const names = Object.keys(manifest.dependencies ?? {});

  return names.filter((name) => !name.startsWith('@neem/'));
}

async function main() {
  const outfile = path.join(API, 'dist', 'server.js');

  // The old tsc output nested under dist/apps/api/src. Removing the whole
  // directory keeps a stale tree from being mistaken for this build's.
  rmSync(path.join(API, 'dist'), { recursive: true, force: true });

  const external = externalDependencies();

  const result = await build({
    entryPoints: [path.join(API, 'src', 'server.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    // Node 22+, which is what the README requires and what `tsx` runs.
    target: 'node22',
    // The codebase is ESM throughout, and `apps/api/package.json` says
    // `"type": "module"`. Emitting CJS here would break `import.meta` usage.
    format: 'esm',
    external,
    sourcemap: true,
    // Not minified: a stack trace from production should name the function
    // that threw. The bundle is read by people far more often than it is
    // shipped over a network.
    minify: false,
    logLevel: 'warning',
    metafile: true,
  });

  const bytes = Object.values(result.metafile.outputs).reduce(
    (total, output) => total + output.bytes,
    0,
  );

  console.log(`  ✓ ${path.relative(ROOT, outfile)} — ${(bytes / 1024).toFixed(0)} kB`);
  console.log(`    ${external.length} dependencies left external, resolved from node_modules`);
  console.log('    types are NOT checked here — run `npm run typecheck`');
}

// `pathToFileURL` rather than string-building: on Windows a raw path never
// matches `import.meta.url`, and the script silently does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('\nThe API build failed:\n', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
