import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const downloadedChromium = `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || (existsSync(downloadedChromium) ? downloadedChromium : undefined);

export default defineConfig({
  testDir: './tests/performance',
  outputDir: './tmp/player-performance/test-results',
  reporter: [['line']],
  timeout: 0,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_PERF_BASE_URL || 'http://127.0.0.1:3012',
    browserName: 'chromium',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: process.env.PLAYWRIGHT_PERF_BASE_URL ? undefined : {
    command: 'PORT=3012 PLAYER_FIXTURES=1 WIDEVINE_LICENSE_URL=/widevine-license npm run start:single',
    url: 'http://127.0.0.1:3012/auth/login',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
