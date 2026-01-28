import type { Page } from '@playwright/test';
import { TEST_TIMEOUTS } from '../config';

export class ExecutionPage {
  constructor(private page: Page) {}

  get statusBadge() {
    return this.page.getByTestId('execution-status-badge');
  }

  get cancelButton() {
    return this.page.getByTestId('execution-cancel-button');
  }

  get thinkingIndicator() {
    return this.page.getByTestId('execution-thinking-indicator');
  }

  get followUpInput() {
    return this.page.getByTestId('execution-follow-up-input');
  }

  get stopButton() {
    return this.page.getByTestId('execution-stop-button');
  }

  get permissionModal() {
    return this.page.getByTestId('execution-permission-modal');
  }

  get allowButton() {
    return this.page.getByTestId('permission-allow-button');
  }

  get denyButton() {
    return this.page.getByTestId('permission-deny-button');
  }

  /** Get all question option buttons inside the permission modal */
  get questionOptions() {
    return this.permissionModal.locator('button').filter({ hasText: /Option|Other/ });
  }

  /** Get the custom response text input (visible when "Other" is selected) */
  get customResponseInput() {
    return this.page.getByPlaceholder('Type your response...');
  }

  /** Get the "Back to options" button (visible in custom input mode) */
  get backToOptionsButton() {
    return this.page.getByText('← Back to options');
  }

  /** Select a question option by index (0-based) */
  async selectQuestionOption(index: number) {
    await this.questionOptions.nth(index).click();
  }

  async waitForComplete() {
    // Wait for status badge to show a completed state (not running)
    await this.page.waitForFunction(
      () => {
        const badge = document.querySelector('[data-testid="execution-status-badge"]');
        if (!badge) return false;
        const text = badge.textContent?.toLowerCase() || '';
        return text.includes('completed') || text.includes('failed') || text.includes('stopped') || text.includes('cancelled');
      },
      { timeout: TEST_TIMEOUTS.TASK_COMPLETE_WAIT }
    );
  }
}
