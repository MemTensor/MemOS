/**
 * Integration tests for TaskInputBar component
 * Tests component rendering and user interactions with mocked window.accomplish API
 * @module __tests__/integration/renderer/components/TaskInputBar.integration.test
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskInputBar from '@/components/landing/TaskInputBar';

// Mock analytics to prevent tracking calls
vi.mock('@/lib/analytics', () => ({
  analytics: {
    trackSubmitTask: vi.fn(),
  },
}));

// Mock accomplish API
const mockAccomplish = {
  logEvent: vi.fn().mockResolvedValue(undefined),
  getSelectedModel: vi.fn().mockResolvedValue({ provider: 'anthropic', id: 'claude-3-opus' }),
  getOllamaConfig: vi.fn().mockResolvedValue(null),
  isE2EMode: vi.fn().mockResolvedValue(false),
  getProviderSettings: vi.fn().mockResolvedValue({
    activeProviderId: 'anthropic',
    connectedProviders: {
      anthropic: {
        providerId: 'anthropic',
        connectionStatus: 'connected',
        selectedModelId: 'claude-3-5-sonnet-20241022',
        credentials: { type: 'api-key', apiKey: 'test-key' },
      },
    },
    debugMode: false,
  }),
  // Provider settings methods
  setActiveProvider: vi.fn().mockResolvedValue(undefined),
  setConnectedProvider: vi.fn().mockResolvedValue(undefined),
  removeConnectedProvider: vi.fn().mockResolvedValue(undefined),
  setProviderDebugMode: vi.fn().mockResolvedValue(undefined),
  validateApiKeyForProvider: vi.fn().mockResolvedValue({ valid: true }),
  validateBedrockCredentials: vi.fn().mockResolvedValue({ valid: true }),
  saveBedrockCredentials: vi.fn().mockResolvedValue(undefined),
};

// Mock the accomplish module
vi.mock('@/lib/accomplish', () => ({
  getAccomplish: () => mockAccomplish,
}));

describe('TaskInputBar Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render with empty state', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Assert
      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveValue('');
    });

    it('should render with default placeholder', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Assert
      const textarea = screen.getByPlaceholderText('Assign a task or ask anything');
      expect(textarea).toBeInTheDocument();
    });

    it('should render with custom placeholder', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      const customPlaceholder = 'Enter your task here';

      // Act
      render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={customPlaceholder}
        />
      );

      // Assert
      const textarea = screen.getByPlaceholderText(customPlaceholder);
      expect(textarea).toBeInTheDocument();
    });

    it('should render with provided value', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      const taskValue = 'Review my inbox for urgent messages';

      // Act
      render(
        <TaskInputBar
          value={taskValue}
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Assert
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveValue(taskValue);
    });

    it('should render submit button', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Assert
      const submitButton = screen.getByRole('button', { name: /submit/i });
      expect(submitButton).toBeInTheDocument();
    });
  });

  describe('user input handling', () => {
    it('should call onChange when user types', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Act
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'New task input' } });

      // Assert
      expect(onChange).toHaveBeenCalledWith('New task input');
    });

    it('should call onChange with each input change', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      const { rerender } = render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Act - First change
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'First' } });

      // Rerender with updated value
      rerender(
        <TaskInputBar
          value="First"
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Act - Second change
      fireEvent.change(textarea, { target: { value: 'First input' } });

      // Assert
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenNthCalledWith(1, 'First');
      expect(onChange).toHaveBeenNthCalledWith(2, 'First input');
    });
  });

  describe('submit button behavior', () => {
    it('should disable submit button when value is empty', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Assert
      const submitButton = screen.getByRole('button', { name: /submit/i });
      expect(submitButton).toBeDisabled();
    });

    it('should disable submit button when value is only whitespace', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value="   "
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Assert
      const submitButton = screen.getByRole('button', { name: /submit/i });
      expect(submitButton).toBeDisabled();
    });

    it('should enable submit button when value has content', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value="Check my calendar"
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Assert
      const submitButton = screen.getByRole('button', { name: /submit/i });
      expect(submitButton).not.toBeDisabled();
    });

    it('should call onSubmit when submit button is clicked', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      render(
        <TaskInputBar
          value="Submit this task"
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Act
      const submitButton = screen.getByRole('button', { name: /submit/i });
      fireEvent.click(submitButton);

      // Assert
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('should call onSubmit when Enter is pressed without Shift', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      render(
        <TaskInputBar
          value="Submit via Enter"
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Act
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Assert
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('should not call onSubmit when Shift+Enter is pressed', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      render(
        <TaskInputBar
          value="Multiline text"
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Act
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      // Assert
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('should not submit when clicking disabled button', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
        />
      );

      // Act
      const submitButton = screen.getByRole('button', { name: /submit/i });
      fireEvent.click(submitButton);

      // Assert
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('loading state', () => {
    it('should disable textarea when loading', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value="Task in progress"
          onChange={onChange}
          onSubmit={onSubmit}
          isLoading={true}
        />
      );

      // Assert
      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeDisabled();
    });

    it('should disable submit button when loading', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value="Task in progress"
          onChange={onChange}
          onSubmit={onSubmit}
          isLoading={true}
        />
      );

      // Assert
      const submitButton = screen.getByRole('button', { name: /submit/i });
      expect(submitButton).toBeDisabled();
    });

    it('should show loading spinner in submit button when loading', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value="Task in progress"
          onChange={onChange}
          onSubmit={onSubmit}
          isLoading={true}
        />
      );

      // Assert - Check for the animate-spin class on the loader icon
      const submitButton = screen.getByRole('button', { name: /submit/i });
      const spinner = submitButton.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });

    it('should have disabled textarea that prevents user input when loading', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      render(
        <TaskInputBar
          value="Loading task"
          onChange={onChange}
          onSubmit={onSubmit}
          isLoading={true}
        />
      );

      // Assert - textarea is disabled, preventing real user interaction
      // Note: In jsdom, keydown events still fire on disabled elements,
      // but in a real browser, disabled elements don't receive keyboard input
      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeDisabled();
    });
  });

  describe('disabled state', () => {
    it('should disable textarea when disabled prop is true', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value="Disabled input"
          onChange={onChange}
          onSubmit={onSubmit}
          disabled={true}
        />
      );

      // Assert
      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeDisabled();
    });

    it('should disable submit button when disabled prop is true', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value="Disabled input"
          onChange={onChange}
          onSubmit={onSubmit}
          disabled={true}
        />
      );

      // Assert
      const submitButton = screen.getByRole('button', { name: /submit/i });
      expect(submitButton).toBeDisabled();
    });
  });

  describe('large variant', () => {
    it('should apply large text style when large prop is true', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
          large={true}
        />
      );

      // Assert
      const textarea = screen.getByRole('textbox');
      expect(textarea.className).toContain('text-[20px]');
    });

    it('should apply default text size when large prop is false', () => {
      // Arrange
      const onChange = vi.fn();
      const onSubmit = vi.fn();

      // Act
      render(
        <TaskInputBar
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
          large={false}
        />
      );

      // Assert
      const textarea = screen.getByRole('textbox');
      expect(textarea.className).toContain('text-sm');
    });
  });
});
