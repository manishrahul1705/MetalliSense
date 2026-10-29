import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';

export default [
  // Generated build outputs and dependency trees only; all application JS/JSX,
  // mock code, test runners and configuration files remain checked.
  { ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },
  { files: ['**/*.{js,jsx,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } }, globals: { ...globals.browser, ...globals.node } },
    plugins: { react, 'react-hooks': hooks, 'react-refresh': refresh },
    rules: { ...js.configs.recommended.rules,
      'react/jsx-uses-react': 'error', 'react/jsx-uses-vars': 'error',
      // Pre-existing unused bindings and dependency omissions are visible warnings;
      // undefined names, syntax and hook-order violations remain blocking errors.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  }
];
