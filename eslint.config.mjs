import js from '@eslint/js'
import typescriptParser from '@typescript-eslint/parser'
import typescript from '@typescript-eslint/eslint-plugin'
import overleaf from '@overleaf/eslint-plugin'
import globals from 'globals'

// Changed files are linted at commit/PR time; production types/tests run in full.
export default [
  {
    ignores: [
      '.yarn/**',
      '.cache/**',
      '**/node_modules/**',
      '**/data/reports/**',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs,jsx,ts,tsx,mts}'],
    languageOptions: {
      parser: typescriptParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.node,
    },
    plugins: { '@overleaf': overleaf, '@typescript-eslint': typescript },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    files: ['**/frontend/**', '**/shared/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['**/test/**', '**/*.test.*', '**/*.spec.*'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.mocha,
        ...globals.vitest,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts}'],
    rules: {
      'no-undef': 'off', // TypeScript checks names in both public production gates.
      'no-redeclare': 'off', // TypeScript validates overloads and merged declarations.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
    },
  },
]
