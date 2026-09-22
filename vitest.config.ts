import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 主进程模块会被 node 直接 import，无需 electron 运行时
    globals: false,
    restoreMocks: true,
  },
});
