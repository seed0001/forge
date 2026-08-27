import { createServer } from 'vite';
import esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Kept out of the bundle in dev too, so its behavior matches the packaged
  // build exactly — see the comment in build-main.mjs.
  external: ['electron', 'electron-updater', 'ws', 'axios'],
  sourcemap: true,
};

async function buildMainProcess() {
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(root, 'electron', 'main.ts')],
    outfile: path.join(root, 'dist-electron', 'main.js'),
    // See the matching comment in build-main.mjs — polyfills `require` so
    // msedge-tts's bundled internal require("axios") resolves at runtime.
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  });

  // page-extract.ts injects these into the live browsed page and runs
  // extraction there (a real DOM, no jsdom/Node bundling needed).
  fs.mkdirSync(path.join(root, 'dist-electron', 'vendor'), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'node_modules', '@mozilla', 'readability', 'Readability.js'),
    path.join(root, 'dist-electron', 'vendor', 'Readability.js')
  );
  fs.copyFileSync(
    path.join(root, 'node_modules', 'turndown', 'lib', 'turndown.browser.umd.js'),
    path.join(root, 'dist-electron', 'vendor', 'turndown.umd.js')
  );
  await esbuild.build({
    ...shared,
    format: 'cjs',
    entryPoints: [path.join(root, 'electron', 'preload.ts')],
    outfile: path.join(root, 'dist-electron', 'preload.cjs'),
  });

  await esbuild.build({
    ...shared,
    format: 'cjs',
    entryPoints: [path.join(root, 'electron', 'overlay-preload.ts')],
    outfile: path.join(root, 'dist-electron', 'overlay-preload.cjs'),
  });
}

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = `http://localhost:${server.config.server.port}/`;
console.log(`[forge] renderer dev server: ${url}`);

await buildMainProcess();
console.log('[forge] main process built');

let child = null;

function launchElectron() {
  child = spawn(electronPath, [path.join(root, 'dist-electron', 'main.js')], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  child.on('close', () => {
    server.close();
    process.exit(0);
  });
}

launchElectron();

process.on('SIGINT', () => {
  child?.kill();
  server.close();
  process.exit(0);
});
