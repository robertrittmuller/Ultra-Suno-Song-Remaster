import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // AudioWorklet modules are loaded as scripts and must obey the app's CSP.
    // Do not turn small assets into data: URLs; `script-src 'self'` permits the
    // emitted file while intentionally rejecting data: script execution.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html')
      }
    }
  },
  server: {
    port: 5173
  }
});
