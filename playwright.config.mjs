import { defineConfig } from '@playwright/test';
import { existsSync } from 'fs';

const downloadedChromium = `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || (existsSync(downloadedChromium) ? downloadedChromium : undefined);

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011',
    browserName: 'chromium',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'PORT=3011 PLAYER_FIXTURES=1 npm run start:single',
    url: 'http://127.0.0.1:3011/auth/login',
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
