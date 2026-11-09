import { defineConfig, devices } from '@playwright/test';

// E2E (NEW_DESIGN.md 12.2): Stack aus e2e/stack.ts (PostgreSQL per Testcontainers, Twitch-Stub) plus Vite-Dev-Server mit Proxy.
const API = 'http://127.0.0.1:3100';
const WEB = 'http://localhost:3101';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    locale: 'de-DE',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx e2e/stack.ts',
      url: `${API}/healthz`,
      timeout: 300_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npx vite dev --port 3101 --strictPort',
      url: WEB,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { API_URL: API },
    },
  ],
});
