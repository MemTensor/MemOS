/**
 * Centralized timeout constants for E2E tests.
 * Adjust these based on CI environment performance.
 */
export const TEST_TIMEOUTS = {
  /** Time for CSS animations to complete */
  ANIMATION: 300,

  /** Short wait for React state updates */
  STATE_UPDATE: 500,

  /** Time for React hydration after page load */
  HYDRATION: 1500,

  /** Time between app close and next launch (single-instance lock release) */
  APP_RESTART: 1000,

  /** Task completion with mock flow */
  TASK_COMPLETION: 3000,

  /** Navigation between pages */
  NAVIGATION: 5000,

  /** Permission modal appearance */
  PERMISSION_MODAL: 10000,

  /** Wait for task to reach completed/failed/stopped state */
  TASK_COMPLETE_WAIT: 20000,
} as const;

/**
 * Test scenario definitions with explicit keywords.
 * Using prefixed keywords to avoid false positives.
 */
export const TEST_SCENARIOS = {
  SUCCESS: {
    keyword: '__e2e_success__',
    description: 'Task completes successfully',
  },
  WITH_TOOL: {
    keyword: '__e2e_tool__',
    description: 'Task uses tools (Read, Grep)',
  },
  PERMISSION: {
    keyword: '__e2e_permission__',
    description: 'Task requires file permission',
  },
  ERROR: {
    keyword: '__e2e_error__',
    description: 'Task fails with error',
  },
  INTERRUPTED: {
    keyword: '__e2e_interrupt__',
    description: 'Task is interrupted by user',
  },
  QUESTION: {
    keyword: '__e2e_question__',
    description: 'Task requires user question/choice',
  },
} as const;

export type TestScenario = keyof typeof TEST_SCENARIOS;
