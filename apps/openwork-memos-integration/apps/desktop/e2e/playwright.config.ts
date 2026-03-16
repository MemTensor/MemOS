import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',

  // Serial execution (Electron single-instance)
  workers: 1,
  fullyParallel: false,

  // Timeouts
  timeout: 60000,
  expect: {
    timeout: 10000,
    toHaveScreenshot: { maxDiffPixels: 100, threshold: 0.2 }
  },

  // Retry on CI
  retries: process.env.CI ? 2 : 0,

  // Reporters (paths relative to config file location)
  reporter: [
    ['html', { outputFolder: './html-report' }],
    ['json', { outputFile: './test-results.json' }],
    ['list']
  ],

  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'electron-fast',
      testMatch: /.*(home|execution|settings|settings-bedrock)\.spec\.ts/,
      timeout: 60000,
    },
    {
      name: 'electron-integration',
      testMatch: /.*integration\.spec\.ts/,
      timeout: 120000,
      retries: 0,
    }
  ],
});
