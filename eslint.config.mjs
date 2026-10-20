import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // 2026-10-20 补 `src-tauri/target/**`：
    // `eslint .` 会一路走进 Rust 的构建产物 —— Tauri 的 build script 会在
    // `src-tauri/target/debug/build/*/out/` 下生成 `__global-api-script.js`，
    // 那个文件是**生成物**（且首行就是个裸表达式）⇒ 触发
    // `@typescript-eslint/no-unused-expressions` ⇒ Windows CI 的 Lint 步骤红了。
    // lint 生成物没有意义，直接忽略。
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      'scripts/**',
      'whisper.cpp/**',
      'src-tauri/target/**',
      'vite.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-case-declarations': 'off',
      'prefer-const': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-param-reassign': 'off',
    },
  }
);

