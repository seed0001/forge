import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // electron-updater ships native/binary helpers (7zip-bin, etc.) that it locates
  // via its own __dirname/require.resolve at runtime — bundling it would rewrite
  // those paths and break differential-update downloads. Left as a real
  // node_modules dependency instead; electron-builder packages it unmodified.
  external: ['electron', 'electron-updater'],
  minify: true,
};

await esbuild.build({
  ...shared,
  entryPoints: [path.join(root, 'electron', 'main.ts')],
  outfile: path.join(root, 'dist-electron', 'main.js'),
});

await esbuild.build({
  ...shared,
  format: 'cjs',
  entryPoints: [path.join(root, 'electron', 'preload.ts')],
  outfile: path.join(root, 'dist-electron', 'preload.cjs'),
});

console.log('[forge] main process built for production');
