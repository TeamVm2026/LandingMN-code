
import { defineConfig, devices } from '@playwright/test';
import { GUARDED_PORTS, occupiedPorts, portGuardMessage } from './scripts/lib/preflight.ts';

export const MOBILE_VIEWPORT = { width: 390, height: 844 };
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

export const PREVIEW_PORT = Number(process.env.PREVIEW_PORT ?? 4321);
const PORT = PREVIEW_PORT;
const BASE_URL = `http://localhost:${PORT}`;

if (process.env.TEST_WORKER_INDEX === undefined) {

  const guarded = GUARDED_PORTS.map((port) => (port === 4321 ? PORT : port));
  const occupied = await occupiedPorts(guarded);
  if (occupied.length > 0) {
    throw new Error(portGuardMessage(occupied));
  }
}

export default defineConfig({
  testDir: './tests',

  testMatch: '*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {

    command: `npm run build && npm run preview -- --port ${PORT} --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
