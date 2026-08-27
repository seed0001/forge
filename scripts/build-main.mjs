import esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
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
  // ws (used by the phone portal's WebSocket server) is external for a
  // narrower reason: esbuild's ESM output can't polyfill its internal dynamic
  // `require()`s of Node builtins (events, stream, ...) — left unbundled,
  // Node's own loader resolves those natively. It's a real "dependency" in
  // package.json, so electron-builder ships it in node_modules the same way
  // it already does electron-updater.
  // axios (pulled in transitively by msedge-tts, used for its voice-list
  // fetch) hits the same class of problem via combined-stream/form-data's
  // dynamic `require("util")` — left external for the same reason. npm
  // still installs it under node_modules as msedge-tts's own dependency, so
  // electron-builder ships it unmodified without needing a direct entry in
  // package.json.
  external: ['electron', 'electron-updater', 'ws', 'axios'],
  minify: true,
};

await esbuild.build({
  ...shared,
  entryPoints: [path.join(root, 'electron', 'main.ts')],
  outfile: path.join(root, 'dist-electron', 'main.js'),
  // msedge-tts ships as CommonJS and gets bundled (unlike axios/ws, it isn't
  // external); its internal require("axios") calls go through esbuild's
  // __require2 shim, which falls back to a real `require` — absent by
  // default in an ESM module. This polyfills one via node:module so that
  // fallback actually resolves axios from node_modules at runtime instead
  // of throwing "Dynamic require of axios is not supported".
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});

// page-extract.ts injects these two small libraries into the live browsed
// page and runs extraction there (a real DOM, no jsdom needed) — copied
// alongside the bundle so they ship in the packaged app the same way
// dist-electron's other output does, with no node_modules dependency at
// runtime.
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

// Preload for the transparent desktop Orb overlay window.
await esbuild.build({
  ...shared,
  format: 'cjs',
  entryPoints: [path.join(root, 'electron', 'overlay-preload.ts')],
  outfile: path.join(root, 'dist-electron', 'overlay-preload.cjs'),
});

console.log('[forge] main process built for production');
