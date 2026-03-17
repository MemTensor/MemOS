# E2E Test Infrastructure

This directory contains the E2E test infrastructure for the Openwork desktop app using Playwright.

## Structure

```
e2e/
├── fixtures/          # Test fixtures (Electron app launch)
├── pages/             # Page object models
├── specs/             # Test specifications
├── utils/             # Test utilities (screenshots, helpers)
└── test-results/      # Test output (screenshots, videos, traces)
```

## Fixtures

### electron-app.ts

Provides Electron app launch fixture with E2E configuration:

- **electronApp**: Launches the Electron app with E2E flags
- **window**: Returns the first window (main app window)

Environment variables automatically set:
- `E2E_SKIP_AUTH=1` - Skip onboarding flow
- `E2E_MOCK_TASK_EVENTS=1` - Mock task execution events

## Page Objects

### HomePage

Methods for interacting with the home page:
- `title` - Home page title
- `taskInput` - Task input textarea
- `submitButton` - Submit button
- `getExampleCard(index)` - Get example card by index
- `enterTask(text)` - Enter task text
- `submitTask()` - Submit task

### ExecutionPage

Methods for interacting with the task execution page:
- `statusBadge` - Status badge
- `cancelButton` - Cancel button
- `thinkingIndicator` - Thinking indicator
- `followUpInput` - Follow-up input
- `stopButton` - Stop button
- `permissionModal` - Permission modal
- `allowButton` - Allow button (in permission modal)
- `denyButton` - Deny button (in permission modal)
- `waitForComplete()` - Wait for task completion

### SettingsPage

Methods for interacting with the settings page:
- `title` - Settings page title
- `debugModeToggle` - Debug mode toggle
- `modelSection` - Model section
- `modelSelect` - Model select dropdown
- `apiKeyInput` - API key input
- `addApiKeyButton` - Add API key button
- `navigateToSettings()` - Navigate to settings page
- `toggleDebugMode()` - Toggle debug mode
- `selectModel(modelName)` - Select a model
- `addApiKey(provider, key)` - Add API key

## Utilities

### screenshots.ts

Provides AI-friendly screenshot capture with metadata:

```typescript
import { captureForAI } from '../utils';

await captureForAI(
  page,
  'task-execution',
  'running',
  [
    'Task is actively running',
    'Status badge shows "Running"',
    'Cancel button is visible'
  ]
);
```

The utility creates:
- `{testName}-{stateName}-{timestamp}.png` - Screenshot
- `{testName}-{stateName}-{timestamp}.json` - Metadata (viewport, route, criteria)

## Usage Example

```typescript
import { test, expect } from '../fixtures';
import { HomePage, ExecutionPage } from '../pages';
import { captureForAI } from '../utils';

test('should submit a task and navigate to execution', async ({ window }) => {
  const homePage = new HomePage(window);
  const executionPage = new ExecutionPage(window);

  // Enter task
  await homePage.enterTask('Create a new file called hello.txt');
  await homePage.submitTask();

  // Wait for navigation to execution page
  await executionPage.statusBadge.waitFor({ state: 'visible' });

  // Capture screenshot for AI evaluation
  await captureForAI(
    window,
    'task-submission',
    'execution-started',
    ['Task execution page loaded', 'Status badge visible']
  );

  // Assert
  await expect(executionPage.statusBadge).toBeVisible();
});
```

## Running Tests

Tests run in Docker by default (both locally and in CI). This ensures consistent behavior and enables concurrent test runs from multiple worktrees.

### Prerequisites

- Docker Desktop installed and running

### Commands

```bash
# Run all E2E tests (in Docker)
pnpm test:e2e

# Pre-build Docker image (useful for caching)
pnpm test:e2e:build

# Clean up Docker resources
pnpm test:e2e:clean

# View HTML report
pnpm test:e2e:report
```

### Native Mode (for debugging)

Run tests directly without Docker when you need Playwright UI or debugger:

```bash
# Run natively (Electron windows will pop up)
pnpm test:e2e:native

# Run with Playwright UI
pnpm test:e2e:native:ui

# Run in debug mode
pnpm test:e2e:native:debug

# Run fast tests only
pnpm test:e2e:native:fast

# Run integration tests only
pnpm test:e2e:native:integration
```

## How Docker Testing Works

1. Docker container runs Ubuntu with Xvfb (X Virtual Framebuffer)
2. Xvfb provides a virtual display at `:99`
3. Electron runs "headfully" inside the container, but the display is virtual
4. Test results are mounted to the host for viewing

### Concurrent Worktree Testing

Each worktree can run `pnpm test:e2e` simultaneously because:
- Each container has its own isolated filesystem
- Each container has its own virtual display
- Electron's single-instance lock is per-container, not per-host

### Troubleshooting

**Tests fail with "cannot open display"**
- Ensure Xvfb is starting (check Docker logs)
- Verify `DISPLAY=:99` is set

**Tests fail with sandbox errors**
- The `--no-sandbox` flag is automatically added in Docker
- Ensure `DOCKER_ENV=1` is in the environment

**Out of memory errors**
- Increase Docker's memory allocation in Docker Desktop settings
- The compose file sets `shm_size: 2gb` for Chromium

## Writing Tests

1. Import fixtures and page objects:
   ```typescript
   import { test, expect } from '../fixtures';
   import { HomePage } from '../pages';
   ```

2. Use page objects instead of direct selectors:
   ```typescript
   // Good
   await homePage.submitTask();

   // Bad
   await window.getByTestId('task-input-submit').click();
   ```

3. Add test IDs to new UI elements in renderer:
   ```tsx
   <button data-testid="my-button">Click me</button>
   ```

4. Use `captureForAI` for screenshots with evaluation criteria:
   ```typescript
   await captureForAI(
     window,
     'my-test',
     'some-state',
     ['Criterion 1', 'Criterion 2']
   );
   ```

## Best Practices

- Use page objects for all UI interactions
- Add descriptive test IDs (`data-testid`) to UI elements
- Use `captureForAI` for important states to enable AI-based evaluation
- Keep tests focused and independent
- Use serial execution (configured in playwright.config.ts)
- Mock task events for fast tests, use real execution for integration tests
