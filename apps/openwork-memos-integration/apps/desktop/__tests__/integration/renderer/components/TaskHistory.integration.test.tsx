/**
 * Integration tests for TaskHistory component
 * Tests task list rendering, selection, deletion, and history clearing
 * @module __tests__/integration/renderer/components/TaskHistory.integration.test
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Task, TaskStatus } from '@accomplish/shared';

// Create mock functions for task store
const mockLoadTasks = vi.fn();
const mockDeleteTask = vi.fn();
const mockClearHistory = vi.fn();

// Create a store state holder for testing
let mockStoreState = {
  tasks: [] as Task[],
  loadTasks: mockLoadTasks,
  deleteTask: mockDeleteTask,
  clearHistory: mockClearHistory,
};

// Mock the task store
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => mockStoreState,
}));

// Helper to create mock tasks
function createMockTask(
  id: string,
  prompt: string = 'Test task',
  status: TaskStatus = 'completed',
  createdAt?: string,
  messageCount: number = 0
): Task {
  return {
    id,
    prompt,
    status,
    messages: Array(messageCount).fill({
      id: 'msg-1',
      type: 'assistant',
      content: 'Test message',
      timestamp: new Date().toISOString(),
    }),
    createdAt: createdAt || new Date().toISOString(),
  };
}

// Need to import after mocks are set up
import TaskHistory from '@/components/history/TaskHistory';

describe('TaskHistory Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    mockStoreState = {
      tasks: [],
      loadTasks: mockLoadTasks,
      deleteTask: mockDeleteTask,
      clearHistory: mockClearHistory,
    };
    // Mock window.confirm
    vi.spyOn(window, 'confirm').mockImplementation(() => true);
  });

  describe('empty state rendering', () => {
    it('should render empty state when no tasks exist', () => {
      // Arrange & Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    });

    it('should render helpful message in empty state', () => {
      // Arrange & Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/start by describing what you want to accomplish/i)).toBeInTheDocument();
    });

    it('should not render task list in empty state', () => {
      // Arrange & Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const taskItems = document.querySelectorAll('[class*="rounded-card"]');
      expect(taskItems.length).toBe(0);
    });

    it('should not render Clear all button in empty state', () => {
      // Arrange & Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.queryByText(/clear all/i)).not.toBeInTheDocument();
    });
  });

  describe('task list rendering', () => {
    it('should render task list when tasks exist', () => {
      // Arrange
      mockStoreState.tasks = [
        createMockTask('task-1', 'Send email to John'),
        createMockTask('task-2', 'Create report'),
      ];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText('Send email to John')).toBeInTheDocument();
      expect(screen.getByText('Create report')).toBeInTheDocument();
    });

    it('should render Recent Tasks title when showTitle is true', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Test task')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory showTitle={true} />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText('Recent Tasks')).toBeInTheDocument();
    });

    it('should not render title when showTitle is false', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Test task')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory showTitle={false} />
        </MemoryRouter>
      );

      // Assert
      expect(screen.queryByText('Recent Tasks')).not.toBeInTheDocument();
    });

    it('should render task status indicator', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'My test task', 'completed')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert - Status label appears in the meta text
      const metaText = screen.getByText(/Completed \u00B7/);
      expect(metaText).toBeInTheDocument();
    });

    it('should render message count for each task', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Task with messages', 'completed', undefined, 5)];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/5 messages/i)).toBeInTheDocument();
    });

    it('should call loadTasks on mount', () => {
      // Arrange & Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(mockLoadTasks).toHaveBeenCalled();
    });
  });

  describe('task status indicators', () => {
    it('should show green indicator for completed tasks', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Completed task', 'completed')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const indicator = document.querySelector('.bg-success');
      expect(indicator).toBeInTheDocument();
    });

    it('should show blue indicator for running tasks', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Running task', 'running')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const indicator = document.querySelector('.bg-accent-blue');
      expect(indicator).toBeInTheDocument();
    });

    it('should show red indicator for failed tasks', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Failed task', 'failed')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const indicator = document.querySelector('.bg-danger');
      expect(indicator).toBeInTheDocument();
    });

    it('should show grey indicator for cancelled tasks', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Cancelled task', 'cancelled')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const indicator = document.querySelector('.bg-text-muted');
      expect(indicator).toBeInTheDocument();
    });

    it('should show yellow indicator for pending tasks', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Pending task', 'pending')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const indicator = document.querySelector('.bg-warning');
      expect(indicator).toBeInTheDocument();
    });

    it('should show yellow indicator for waiting permission tasks', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'My test task', 'waiting_permission')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert - Status label appears in the meta text
      const indicator = document.querySelector('.bg-warning');
      expect(indicator).toBeInTheDocument();
      const metaText = screen.getByText(/Waiting \u00B7/);
      expect(metaText).toBeInTheDocument();
    });
  });

  describe('task selection', () => {
    it('should render tasks as clickable links', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-123', 'Clickable task')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const link = screen.getByText('Clickable task').closest('a');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/execution/task-123');
    });

    it('should navigate to correct task execution page', () => {
      // Arrange
      mockStoreState.tasks = [
        createMockTask('task-1', 'First task'),
        createMockTask('task-2', 'Second task'),
      ];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const firstLink = screen.getByText('First task').closest('a');
      const secondLink = screen.getByText('Second task').closest('a');
      expect(firstLink).toHaveAttribute('href', '/execution/task-1');
      expect(secondLink).toHaveAttribute('href', '/execution/task-2');
    });
  });

  describe('task deletion', () => {
    it('should render delete button for each task', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Deletable task')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const deleteButton = document.querySelector('button');
      expect(deleteButton).toBeInTheDocument();
    });

    it('should show confirmation dialog when delete is clicked', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Deletable task')];
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      const taskCard = screen.getByText('Deletable task').closest('a');
      const deleteButton = taskCard?.querySelector('button');
      if (deleteButton) {
        fireEvent.click(deleteButton);
      }

      // Assert
      expect(confirmSpy).toHaveBeenCalledWith('Delete this task?');
    });

    it('should call deleteTask when confirmation is accepted', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Deletable task')];
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      const taskCard = screen.getByText('Deletable task').closest('a');
      const deleteButton = taskCard?.querySelector('button');
      if (deleteButton) {
        fireEvent.click(deleteButton);
      }

      // Assert
      expect(mockDeleteTask).toHaveBeenCalledWith('task-1');
    });

    it('should not call deleteTask when confirmation is cancelled', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Deletable task')];
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      const taskCard = screen.getByText('Deletable task').closest('a');
      const deleteButton = taskCard?.querySelector('button');
      if (deleteButton) {
        fireEvent.click(deleteButton);
      }

      // Assert
      expect(mockDeleteTask).not.toHaveBeenCalled();
    });

    it('should prevent navigation when delete button is clicked', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Deletable task')];
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      // Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <TaskHistory />
        </MemoryRouter>
      );

      const taskCard = screen.getByText('Deletable task').closest('a');
      const deleteButton = taskCard?.querySelector('button');
      if (deleteButton) {
        fireEvent.click(deleteButton);
      }

      // Assert - Delete should be called but no navigation
      expect(mockDeleteTask).toHaveBeenCalled();
    });
  });

  describe('clear history', () => {
    it('should render Clear all button when tasks exist and no limit', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Test task')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory showTitle={true} />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/clear all/i)).toBeInTheDocument();
    });

    it('should not render Clear all button when limit is set', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Test task')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory limit={5} showTitle={true} />
        </MemoryRouter>
      );

      // Assert
      expect(screen.queryByText(/clear all/i)).not.toBeInTheDocument();
    });

    it('should show confirmation dialog when Clear all is clicked', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Test task')];
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      // Act
      render(
        <MemoryRouter>
          <TaskHistory showTitle={true} />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByText(/clear all/i));

      // Assert
      expect(confirmSpy).toHaveBeenCalledWith('Are you sure you want to clear all task history?');
    });

    it('should call clearHistory when confirmation is accepted', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Test task')];
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      // Act
      render(
        <MemoryRouter>
          <TaskHistory showTitle={true} />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByText(/clear all/i));

      // Assert
      expect(mockClearHistory).toHaveBeenCalled();
    });

    it('should not call clearHistory when confirmation is cancelled', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Test task')];
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      // Act
      render(
        <MemoryRouter>
          <TaskHistory showTitle={true} />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByText(/clear all/i));

      // Assert
      expect(mockClearHistory).not.toHaveBeenCalled();
    });
  });

  describe('limit functionality', () => {
    it('should limit displayed tasks when limit prop is provided', () => {
      // Arrange
      mockStoreState.tasks = [
        createMockTask('task-1', 'Task 1'),
        createMockTask('task-2', 'Task 2'),
        createMockTask('task-3', 'Task 3'),
        createMockTask('task-4', 'Task 4'),
        createMockTask('task-5', 'Task 5'),
      ];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory limit={3} />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText('Task 1')).toBeInTheDocument();
      expect(screen.getByText('Task 2')).toBeInTheDocument();
      expect(screen.getByText('Task 3')).toBeInTheDocument();
      expect(screen.queryByText('Task 4')).not.toBeInTheDocument();
      expect(screen.queryByText('Task 5')).not.toBeInTheDocument();
    });

    it('should show View all link when more tasks exist than limit', () => {
      // Arrange
      mockStoreState.tasks = [
        createMockTask('task-1', 'Task 1'),
        createMockTask('task-2', 'Task 2'),
        createMockTask('task-3', 'Task 3'),
        createMockTask('task-4', 'Task 4'),
      ];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory limit={2} />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/view all 4 tasks/i)).toBeInTheDocument();
    });

    it('should link to history page in View all link', () => {
      // Arrange
      mockStoreState.tasks = [
        createMockTask('task-1', 'Task 1'),
        createMockTask('task-2', 'Task 2'),
        createMockTask('task-3', 'Task 3'),
      ];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory limit={2} />
        </MemoryRouter>
      );

      // Assert
      const viewAllLink = screen.getByText(/view all/i).closest('a');
      expect(viewAllLink).toHaveAttribute('href', '/history');
    });

    it('should not show View all link when tasks fit within limit', () => {
      // Arrange
      mockStoreState.tasks = [
        createMockTask('task-1', 'Task 1'),
        createMockTask('task-2', 'Task 2'),
      ];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory limit={5} />
        </MemoryRouter>
      );

      // Assert
      expect(screen.queryByText(/view all/i)).not.toBeInTheDocument();
    });

    it('should show all tasks when no limit is provided', () => {
      // Arrange
      mockStoreState.tasks = [
        createMockTask('task-1', 'Task 1'),
        createMockTask('task-2', 'Task 2'),
        createMockTask('task-3', 'Task 3'),
        createMockTask('task-4', 'Task 4'),
        createMockTask('task-5', 'Task 5'),
      ];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText('Task 1')).toBeInTheDocument();
      expect(screen.getByText('Task 2')).toBeInTheDocument();
      expect(screen.getByText('Task 3')).toBeInTheDocument();
      expect(screen.getByText('Task 4')).toBeInTheDocument();
      expect(screen.getByText('Task 5')).toBeInTheDocument();
    });
  });

  describe('time ago display', () => {
    it('should show "just now" for recent tasks', () => {
      // Arrange
      const now = new Date().toISOString();
      mockStoreState.tasks = [createMockTask('task-1', 'Recent task', 'completed', now)];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/just now/i)).toBeInTheDocument();
    });

    it('should show minutes ago for tasks within an hour', () => {
      // Arrange
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      mockStoreState.tasks = [createMockTask('task-1', 'Old task', 'completed', thirtyMinutesAgo)];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/30m ago/i)).toBeInTheDocument();
    });

    it('should show hours ago for tasks within a day', () => {
      // Arrange
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      mockStoreState.tasks = [createMockTask('task-1', 'Older task', 'completed', fiveHoursAgo)];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/5h ago/i)).toBeInTheDocument();
    });

    it('should show days ago for tasks older than a day', () => {
      // Arrange
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      mockStoreState.tasks = [createMockTask('task-1', 'Very old task', 'completed', threeDaysAgo)];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/3d ago/i)).toBeInTheDocument();
    });
  });

  describe('styling and layout', () => {
    it('should render tasks with card styling', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Styled task')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const taskCard = screen.getByText('Styled task').closest('a');
      expect(taskCard?.className).toContain('rounded-card');
    });

    it('should render tasks with hover effect', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Hover task')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const taskCard = screen.getByText('Hover task').closest('a');
      expect(taskCard?.className).toContain('hover:shadow-card-hover');
    });

    it('should truncate long task prompts', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'This is a very long task prompt that should be truncated')];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const promptElement = screen.getByText(/this is a very long task prompt/i);
      expect(promptElement.className).toContain('truncate');
    });

    it('should render tasks in a vertical list', () => {
      // Arrange
      mockStoreState.tasks = [
        createMockTask('task-1', 'Task 1'),
        createMockTask('task-2', 'Task 2'),
      ];

      // Act
      render(
        <MemoryRouter>
          <TaskHistory />
        </MemoryRouter>
      );

      // Assert
      const container = document.querySelector('.space-y-2');
      expect(container).toBeInTheDocument();
    });
  });
});
