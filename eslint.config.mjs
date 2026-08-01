// Minimal standalone flat config for the root package and its private work source.
// The build remains one published package and does not consume a monorepo config.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // A stub role that ignores its args is intentional in C1; allow the
      // leading-underscore escape hatch so seams read honestly.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The root engine predates this standalone lint gate and has an existing
    // baseline in these rules. Keep the new work source strict without turning
    // the package-unification change into an unrelated engine cleanup.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-useless-escape': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
    },
  },
);
