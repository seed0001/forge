import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  // The app's own version, baked in at build time — shown in the sidebar
  // footer next to the update control. Same source of truth as the release
  // (package.json "version").
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 5273, strictPort: true },
  // Packaged Electron loads index.html via file://, where an absolute asset
  // path resolves against the filesystem root, not the html file's own
  // folder — every script/link tag would silently fail to load, leaving a
  // blank window. Relative paths resolve correctly either way.
  base: './',
  build: { outDir: 'dist' },
});
