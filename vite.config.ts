import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: 'src/renderer',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: path.resolve(__dirname, 'src/renderer/admin/index.html'),
        pet: path.resolve(__dirname, 'src/renderer/pet/index.html'),
      },
    },
  },
  server: {
    port: 5173,
  },
});