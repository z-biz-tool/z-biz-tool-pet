import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: 'src/renderer',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: resolve(import.meta.dirname, 'src/renderer/admin/index.html'),
        pet: resolve(import.meta.dirname, 'src/renderer/pet/index.html'),
      },
    },
  },
  server: {
    // tauri.conf.json 的 devUrl 指向这里，两边必须一致
    port: 5173,
    host: '127.0.0.1',
    strictPort: true,
  },
});
