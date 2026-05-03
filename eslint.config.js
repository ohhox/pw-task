import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/target/**',
      'coverage/**',
      'tests/e2e/**',
      '**/*.min.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        // Browser globals used across the codebase
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Promise: 'readonly',
        crypto: 'readonly',
        CSS: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
      },
    },
    rules: {
      // Loosened during incremental TS migration — tighten later in Phase 1.1.5
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-undef': 'off', // covered by tsc; the legacy script-tag layout shares globals
      'no-empty': ['error', { allowEmptyCatch: true }], // best-effort cleanup is a valid pattern
      'prefer-const': 'warn',
    },
  },
];
