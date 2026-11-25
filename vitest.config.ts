import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/tests/setup.ts'],
          // Deliberately not Madrid: date logic must not depend on the device time zone.
          env: { TZ: 'America/New_York' },
        },
      },
      {
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          globalSetup: ['tests/db/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30000,
          hookTimeout: 120000,
        },
      },
    ],
  },
});
