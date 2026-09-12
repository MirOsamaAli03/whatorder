import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.mjs',
      '**/*.config.ts',
      'packages/database/generated/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      /**
       * Order status must move through the single transition function
       * (ENGINEERING_SPEC.md 16: "Do not allow arbitrary UPDATE orders SET
       * status = ... through controllers"). Scoped to the `order` model
       * specifically — an earlier, broader version of this selector also
       * caught legitimate membership and branch status writes.
       *
       * Enforced from Phase 3, when the orders module lands.
       */
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.property.name='order'][callee.property.name=/^(update|updateMany|upsert)$/] ObjectExpression > Property[key.name='data'] > ObjectExpression > Property[key.name='status']",
          message:
            'Do not write order.status directly. Use transitionOrder() so the state machine, audit record and domain event stay in step (ENGINEERING_SPEC.md 16).',
        },
      ],
    },
  },
);
