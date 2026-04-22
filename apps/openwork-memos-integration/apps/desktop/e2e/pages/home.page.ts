import type { Page } from '@playwright/test';

export class HomePage {
  constructor(private page: Page) {}

  get title() {
    return this.page.getByTestId('home-title');
  }

  get taskInput() {
    return this.page.getByTestId('task-input-textarea');
  }

  get submitButton() {
    return this.page.getByTestId('task-input-submit');
  }

  get examplesToggle() {
    return this.page.getByText('Example prompts');
  }

  getExampleCard(index: number) {
    return this.page.getByTestId(`home-example-${index}`);
  }

  async expandExamples() {
    await this.examplesToggle.click();
  }

  async enterTask(text: string) {
    await this.taskInput.fill(text);
  }

  async submitTask() {
    await this.submitButton.click();
  }
}
