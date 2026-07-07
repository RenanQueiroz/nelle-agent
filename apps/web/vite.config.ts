import {fileURLToPath} from 'node:url';

import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
