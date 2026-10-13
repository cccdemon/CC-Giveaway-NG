import tseslint from 'typescript-eslint';

const NODE_AND_IO = '^(pg|ioredis|fastify|node:.*|fs|net|http|https|crypto|child_process)$';

export default tseslint.config(
  { ignores: ['dist/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/kernel-api/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { regex: '^\\.\\./', message: 'kernel-api enthält nur Typen und importiert nichts aus src.' },
          { regex: NODE_AND_IO, message: 'kernel-api enthält nur Typen und importiert keine Bibliotheken für I/O.' },
        ],
      }],
    },
  },
  {
    files: ['src/kernels/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { regex: '^\\.\\./(?!\\.\\./kernel-api(/|$))', message: 'Ein Kern importiert nur kernel-api (NEW_DESIGN.md 3.4).' },
          { regex: NODE_AND_IO, message: 'Ein Kern ist rein und nutzt kein I/O (NEW_DESIGN.md 4).' },
        ],
      }],
    },
  },
);
