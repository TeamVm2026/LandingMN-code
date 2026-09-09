
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import globals from 'globals';

export default [
  {

    ignores: [
      'dist/',
      'dist-analytics/',
      'dist-empty-analytics/',
      'dist-consent/',
      'node_modules/',

      '**/.astro/',
      '**/.wrangler/',
      'playwright-report/',
      'test-results/',
      '.sabotage-tmp/',

      '.tmp-work/',

      '.playwright-mcp/',

      '.planning/**/tools/',

      '.planning/sketches/',

      '.planning/**/.work/',
      '.planning/**/tmp/',
      'public/',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  ...astro.configs['flat/recommended'],

  {
    files: ['src/scripts/**/*.{ts,js}', 'src/styles/**/*.{ts,js}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.astro'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'scripts/**/*.{ts,js,mjs}',
      'tests/**/*.{ts,js,mjs}',
      '*.{js,mjs,ts}',
      'playwright.config.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {

    files: ['functions/**/*.ts', 'workers/**/*.ts', 'src/server/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.serviceworker } },
  },

  {
    rules: {

      'no-console': 'off',

      'no-useless-assignment': 'off',
    },
  },
  {
    rules: {

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {

    // eslint-disable внутри такого файла живёт до первой синхронизации, а

    files: ['src/env.d.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' },
  },
  {

    files: ['src/components/AttributionHead.astro', 'src/components/AttributionHead.astro/*'],
    rules: {
      'no-var': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
];
