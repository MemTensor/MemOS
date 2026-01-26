import { test, expect } from '../fixtures';
import { HomePage } from '../pages';
import { captureForAI } from '../utils';
import { TEST_TIMEOUTS, TEST_SCENARIOS } from '../config';

test.describe('Home Page', () => {
  test('should load home page with title', async ({ window }) => {
    const homePage = new HomePage(window);

    // Capture initial home page state
    await captureForAI(
      window,
      'home-page-load',
      'initial-load',
      [
        'Title "What will you accomplish today?" is visible',
        'Page layout is correct',
        'All UI elements are rendered'
      ]
    );

    // Assert title is visible and has correct text
    await expect(homePage.title).toBeVisible();
    await expect(homePage.title).toHaveText('What will you accomplish today?');
  });

  test('should display task input and submit button', async ({ window }) => {
    const homePage = new HomePage(window);

    // Capture task input area
    await captureForAI(
      window,
      'home-page-input',
      'task-input-visible',
      [
        'Task input textarea is visible',
        'Submit button is visible',
        'Input area is ready for user interaction'
      ]
    );

    // Assert task input is visible and enabled
    await expect(homePage.taskInput).toBeVisible();
    await expect(homePage.submitButton).toBeVisible();
    await expect(homePage.taskInput).toBeEnabled();
    // Submit button is disabled when input is empty (correct behavior)
    await expect(homePage.submitButton).toBeDisabled();
  });

  test('should allow typing in task input', async ({ window }) => {
    const homePage = new HomePage(window);

    const testTask = 'Write a hello world program';
    await homePage.enterTask(testTask);

    // Capture filled task input
    await captureForAI(
      window,
      'home-page-input',
      'task-input-filled',
      [
        'Task input contains typed text',
        'Text is clearly visible',
        'Submit button is enabled with text'
      ]
    );

    // Assert input value matches what was typed
    await expect(homePage.taskInput).toHaveValue(testTask);
    // Button should now be enabled
    await expect(homePage.submitButton).toBeEnabled();
  });

  test('should display example cards', async ({ window }) => {
    const homePage = new HomePage(window);

    // Capture example cards (examples are expanded by default)
    await captureForAI(
      window,
      'home-page-examples',
      'example-cards-visible',
      [
        'At least 3 example cards are visible',
        'Example cards are properly styled',
        'Cards show task examples to users'
      ]
    );

    // Assert at least 3 example cards are visible
    const exampleCard0 = homePage.getExampleCard(0);
    const exampleCard1 = homePage.getExampleCard(1);
    const exampleCard2 = homePage.getExampleCard(2);

    await expect(exampleCard0).toBeVisible();
    await expect(exampleCard1).toBeVisible();
    await expect(exampleCard2).toBeVisible();
  });

  test('should fill input when clicking an example card', async ({ window }) => {
    const homePage = new HomePage(window);

    // Click the first example card (examples are expanded by default)
    const exampleCard0 = homePage.getExampleCard(0);
    await exampleCard0.click();

    // Wait for input to be filled with example text
    await window.waitForFunction(
      () => {
        const input = document.querySelector('[data-testid="task-input-textarea"]') as HTMLTextAreaElement;
        return input && input.value.length > 0;
      },
      { timeout: TEST_TIMEOUTS.NAVIGATION }
    );

    // Capture state after clicking example
    await captureForAI(
      window,
      'home-page-examples',
      'example-card-clicked',
      [
        'Task input is filled with example text',
        'Input value matches the example card content',
        'User can now submit the pre-filled task'
      ]
    );

    // Assert input is no longer empty
    const inputValue = await homePage.taskInput.inputValue();
    expect(inputValue.length).toBeGreaterThan(0);
  });

  test('should navigate to execution page when submitting a task', async ({ window }) => {
    const homePage = new HomePage(window);

    // Enter a task with explicit test keyword
    await homePage.enterTask(TEST_SCENARIOS.SUCCESS.keyword);

    // Wait for button to be enabled
    await expect(homePage.submitButton).toBeEnabled();

    // Capture before submission
    await captureForAI(
      window,
      'home-page-submit',
      'before-submit',
      [
        'Task is entered in input field',
        'Submit button is ready to click'
      ]
    );

    // Submit the task
    await homePage.submitTask();

    // Wait for navigation
    await window.waitForURL(/.*#\/execution.*/, { timeout: TEST_TIMEOUTS.NAVIGATION });

    // Capture after navigation
    await captureForAI(
      window,
      'home-page-submit',
      'after-submit-navigation',
      [
        'URL changed to execution page',
        'Navigation was successful',
        'Execution page is loading'
      ]
    );

    // Assert URL changed to execution page
    expect(window.url()).toContain('#/execution');
  });

  test('should handle empty input - submit disabled', async ({ window }) => {
    const homePage = new HomePage(window);

    // Capture empty input state
    await captureForAI(
      window,
      'home-page-validation',
      'empty-input',
      [
        'Task input is empty',
        'Submit button is disabled',
        'User cannot submit an empty task'
      ]
    );

    // Submit button should be disabled when input is empty
    await expect(homePage.submitButton).toBeDisabled();
  });

  test('should support multi-line task input', async ({ window }) => {
    const homePage = new HomePage(window);

    // Enter a multi-line task
    const multiLineTask = 'Line 1\nLine 2\nLine 3';
    await homePage.enterTask(multiLineTask);

    // Capture multi-line input
    await captureForAI(
      window,
      'home-page-input',
      'multi-line-task',
      [
        'Task input supports multiple lines',
        'All lines are visible in the textarea',
        'Textarea expands to show content'
      ]
    );

    // Assert all lines are preserved
    await expect(homePage.taskInput).toHaveValue(multiLineTask);
  });
});
