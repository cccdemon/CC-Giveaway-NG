import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

const NO_DIALOGS = 'Keine Browser-Dialoge (NEW_DESIGN.md 11.1). Nutze die Komponente Confirm.';

export default tseslint.config(
  { ignores: ['build/**', '.svelte-kit/**', 'playwright-report/**', 'test-results/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.svelte'] } },
  },
  {
    rules: {
      // Kein Basispfad: href und goto brauchen kein resolve().
      'svelte/no-navigation-without-resolve': 'off',
      'no-restricted-globals': ['error', { name: 'alert', message: NO_DIALOGS }, { name: 'confirm', message: NO_DIALOGS }, { name: 'prompt', message: NO_DIALOGS }],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'alert', message: NO_DIALOGS },
        { object: 'window', property: 'confirm', message: NO_DIALOGS },
        { object: 'window', property: 'prompt', message: NO_DIALOGS },
        { object: 'globalThis', property: 'alert', message: NO_DIALOGS },
        { object: 'globalThis', property: 'confirm', message: NO_DIALOGS },
        { object: 'globalThis', property: 'prompt', message: NO_DIALOGS },
      ],
    },
  },
  {
    // Tests dürfen Browser-Dialoge beobachten, um ihr Fehlen zu beweisen.
    files: ['**/*.test.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-globals': 'off' },
  },
);
