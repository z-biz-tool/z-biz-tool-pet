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
    // 必须显式绑 IPv4：默认只监听 ::1，而 wait-on/Chromium 会先解析到 127.0.0.1，
    // 导致 npm run dev 的 wait-on 永远等不到，Electron 根本不启动
    host: '127.0.0.1',
    strictPort: true,
  },
});