import { test as base, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { TEST_TIMEOUTS } from '../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Custom fixtures for Electron E2E testing.
 */
type ElectronFixtures = {
  /** The Electron application instance */
  electronApp: ElectronApplication;
  /** The main renderer window (not DevTools) */
  window: Page;
};

/**
 * Extended Playwright test with Electron fixtures.
 * Each test gets a fresh app instance to ensure isolation.
 */
export const test = base.extend<ElectronFixtures>({
  electronApp: async ({}, use) => {
    const mainPath = resolve(__dirname, '../../dist-electron/main/index.js');

    const app = await electron.launch({
      args: [
        mainPath,
        '--e2e-skip-auth',
        '--e2e-mock-tasks',
        // Disable sandbox in Docker (required for containerized Electron)
        ...(process.env.DOCKER_ENV === '1' ? ['--no-sandbox', '--disable-gpu'] : []),
      ],
      env: {
        ...process.env,
        E2E_SKIP_AUTH: '1',
        E2E_MOCK_TASK_EVENTS: '1',
        NODE_ENV: 'test',
      },
    });

    await use(app);

    // Close app and wait for single-instance lock release
    await app.close();
    await new Promise(resolve => setTimeout(resolve, TEST_TIMEOUTS.APP_RESTART));
  },

  window: async ({ electronApp }, use) => {
    // Get the first window - DevTools is disabled in E2E mode
    const window = await electronApp.firstWindow();

    // Wait for page to be fully loaded
    await window.waitForLoadState('load');

    // Wait for React hydration by checking for a core UI element
    await window.waitForSelector('[data-testid="task-input-textarea"]', {
      state: 'visible',
      timeout: TEST_TIMEOUTS.NAVIGATION,
    });

    await use(window);
  },
});

export { expect } from '@playwright/test';
