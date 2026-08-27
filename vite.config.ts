import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5273, strictPort: true },
  // Packaged Electron loads index.html via file://, where an absolute asset
  // path resolves against the filesystem root, not the html file's own
  // folder — every script/link tag would silently fail to load, leaving a
  // blank window. Relative paths resolve correctly either way.
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        // The main app window and the transparent desktop Orb overlay are
        // two separate HTML entries served from the same bundle.
        main: resolve(__dirname, 'index.html'),
        overlay: resolve(__dirname, 'overlay.html'),
      },
    },
  },
});
