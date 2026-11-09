import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

// Im Dev-Modus leitet Vite /api an den Fastify-Prozess weiter (NEW_DESIGN.md 3.4: web spricht nur mit api).
const apiUrl = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        // Runes für das ganze Projekt, Bibliotheken ausgenommen. Mit Svelte 6 entfällt das.
        runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
      },
      adapter: adapter(),
    }),
    svelteTesting(),
  ],
  server: {
    proxy: {
      '/api': { target: apiUrl, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
});
