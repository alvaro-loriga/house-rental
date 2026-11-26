import { defineConfig } from '@playwright/test';

// End-to-end tests run the real app against the local backend (scripts/local-backend.mjs):
// a throwaway PostgreSQL with the real migrations plus the demo seed. Separate ports are used
// so a running `npm run dev:local` is left alone.
const API_PORT = 44421;
const DB_PORT = 44422;
const WEB_PORT = 5273;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    // Uses the Chromium-based browser already installed on the machine. Set PW_CHANNEL=chrome,
    // or PW_CHANNEL=chromium after `npx playwright install chromium`, to use another one.
    channel: process.env.PW_CHANNEL ?? 'msedge',
    locale: 'es-ES',
    // Deliberately not Madrid: the app must show Madrid times regardless of the device.
    timezoneId: 'America/New_York',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/local-backend.mjs --with-vite',
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { LOCAL_API_PORT: String(API_PORT), LOCAL_DB_PORT: String(DB_PORT), VITE_PORT: String(WEB_PORT) },
  },
});
