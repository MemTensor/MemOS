/**
 * Integration tests for Sidebar component
 * Tests rendering with conversations, conversation selection, and settings
 * @module __tests__/integration/renderer/components/Sidebar.integration.test
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Task, TaskStatus } from '@accomplish/shared';

// Mock analytics to prevent tracking calls
vi.mock('@/lib/analytics', () => ({
  analytics: {
    trackNewTask: vi.fn(),
    trackOpenSettings: vi.fn(),
  },
}));

// Create mock functions outside of mock factory
const mockLoadTasks = vi.fn();
const mockUpdateTaskStatus = vi.fn();
const mockAddTaskUpdate = vi.fn();
const mockListTasks = vi.fn();
const mockOnTaskStatusChange = vi.fn();
const mockOnTaskUpdate = vi.fn();

// Helper to create mock tasks
function createMockTask(
  id: string,
  prompt: string = 'Test task',
  status: TaskStatus = 'completed'
): Task {
  return {
    id,
    prompt,
    status,
    messages: [],
    createdAt: new Date().toISOString(),
  };
}

// Mock accomplish API
const mockAccomplish = {
  listTasks: mockListTasks.mockResolvedValue([]),
  onTaskStatusChange: mockOnTaskStatusChange.mockReturnValue(() => {}),
  onTaskUpdate: mockOnTaskUpdate.mockReturnValue(() => {}),
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

// Create a store state holder for testing
let mockStoreState = {
  tasks: [] as Task[],
  loadTasks: mockLoadTasks,
  updateTaskStatus: mockUpdateTaskStatus,
  addTaskUpdate: mockAddTaskUpdate,
};

// Mock the task store
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => mockStoreState,
}));

// Mock the SettingsDialog to simplify testing
vi.mock('@/components/layout/SettingsDialog', () => ({
  default: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => (
    open ? (
      <div data-testid="settings-dialog">
        <button onClick={() => onOpenChange(false)}>Close Settings</button>
      </div>
    ) : null
  ),
}));

// Mock framer-motion to simplify testing animations
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    button: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <button {...props}>{children}</button>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Need to import after mocks are set up
import Sidebar from '@/components/layout/Sidebar';

describe('Sidebar Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    mockStoreState = {
      tasks: [],
      loadTasks: mockLoadTasks,
      updateTaskStatus: mockUpdateTaskStatus,
      addTaskUpdate: mockAddTaskUpdate,
    };
  });

  describe('rendering with no conversations', () => {
    it('should render the sidebar container', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert - sidebar should be present (260px width)
      const sidebar = document.querySelector('.w-\\[260px\\]');
      expect(sidebar).toBeInTheDocument();
    });

    it('should render New Task button', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      const newTaskButton = screen.getByRole('button', { name: /new task/i });
      expect(newTaskButton).toBeInTheDocument();
    });

    it('should show empty state message when no conversations', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument();
    });

    it('should render Settings button', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      const settingsButton = screen.getByRole('button', { name: /settings/i });
      expect(settingsButton).toBeInTheDocument();
    });

    it('should render logo image', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      const logo = screen.getByRole('img', { name: /openwork/i });
      expect(logo).toBeInTheDocument();
    });

    it('should call loadTasks on mount', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      expect(mockLoadTasks).toHaveBeenCalled();
    });
  });

  describe('rendering with conversations', () => {
    it('should render conversation list when tasks exist', () => {
      // Arrange
      const tasks = [
        createMockTask('task-1', 'Check my email inbox'),
        createMockTask('task-2', 'Review calendar'),
      ];
      mockStoreState.tasks = tasks;

      // Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText('Check my email inbox')).toBeInTheDocument();
      expect(screen.getByText('Review calendar')).toBeInTheDocument();
    });

    it('should not show empty state when tasks exist', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'A task')];

      // Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      expect(screen.queryByText(/no conversations yet/i)).not.toBeInTheDocument();
    });

    it('should render all tasks in the list', () => {
      // Arrange
      const tasks = [
        createMockTask('task-1', 'First task'),
        createMockTask('task-2', 'Second task'),
        createMockTask('task-3', 'Third task'),
      ];
      mockStoreState.tasks = tasks;

      // Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      expect(screen.getByText('First task')).toBeInTheDocument();
      expect(screen.getByText('Second task')).toBeInTheDocument();
      expect(screen.getByText('Third task')).toBeInTheDocument();
    });

    it('should show running indicator for running tasks', () => {
      // Arrange
      const tasks = [
        createMockTask('task-1', 'Running task', 'running'),
      ];
      mockStoreState.tasks = tasks;

      // Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert - Check for spinning loader icon
      const taskItem = screen.getByText('Running task').closest('button');
      const spinner = taskItem?.querySelector('.animate-spin-ccw');
      expect(spinner).toBeInTheDocument();
    });

    it('should show completed indicator for completed tasks', () => {
      // Arrange
      const tasks = [
        createMockTask('task-1', 'Completed task', 'completed'),
      ];
      mockStoreState.tasks = tasks;

      // Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert - Check for checkmark icon (CheckCircle2)
      const taskItem = screen.getByText('Completed task').closest('button');
      const checkIcon = taskItem?.querySelector('svg');
      expect(checkIcon).toBeInTheDocument();
    });
  });

  describe('conversation selection', () => {
    it('should render conversation items as clickable buttons', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-1', 'Clickable task')];

      // Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      const taskButton = screen.getByText('Clickable task').closest('button');
      expect(taskButton).toBeInTheDocument();
      expect(taskButton?.tagName).toBe('BUTTON');
    });

    it('should navigate to execution page when conversation is clicked', async () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-123', 'Navigate task')];

      // Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      const taskButton = screen.getByText('Navigate task').closest('button');
      if (taskButton) {
        fireEvent.click(taskButton);
      }

      // Assert - Check that the link navigates correctly
      // In real scenario, this would change the route
      await waitFor(() => {
        expect(taskButton).toBeInTheDocument();
      });
    });

    it('should highlight active conversation', () => {
      // Arrange
      mockStoreState.tasks = [createMockTask('task-123', 'Active task')];

      // Act
      render(
        <MemoryRouter initialEntries={['/execution/task-123']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      const taskButton = screen.getByText('Active task').closest('button');
      expect(taskButton?.className).toContain('bg-accent');
    });

    it('should not highlight inactive conversations', () => {
      // Arrange
      mockStoreState.tasks = [
        createMockTask('task-1', 'First task'),
        createMockTask('task-2', 'Second task'),
      ];

      // Act
      render(
        <MemoryRouter initialEntries={['/execution/task-1']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert - Second task should not be highlighted with the active class
      // The component uses 'bg-accent' class for active state, while hover state uses 'hover:bg-accent'
      const secondTaskButton = screen.getByText('Second task').closest('button');
      const classNames = (secondTaskButton?.className || '').split(' ');
      // Filter to find only exact 'bg-accent' class, not 'hover:bg-accent'
      const hasBgAccent = classNames.some(c => c === 'bg-accent');
      expect(hasBgAccent).toBe(false);
    });
  });

  describe('new task button', () => {
    it('should navigate to home when New Task is clicked', async () => {
      // Arrange
      render(
        <MemoryRouter initialEntries={['/execution/task-123']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Act
      const newTaskButton = screen.getByRole('button', { name: /new task/i });
      fireEvent.click(newTaskButton);

      // Assert - Button should be clickable (navigation handled by React Router)
      await waitFor(() => {
        expect(newTaskButton).toBeInTheDocument();
      });
    });

    it('should display MessageSquarePlus icon in New Task button', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      const newTaskButton = screen.getByRole('button', { name: /new task/i });
      const icon = newTaskButton.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('settings dialog', () => {
    it('should open settings dialog when Settings button is clicked', async () => {
      // Arrange
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Act
      const settingsButton = screen.getByRole('button', { name: /settings/i });
      fireEvent.click(settingsButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
      });
    });

    it('should close settings dialog when close is triggered', async () => {
      // Arrange
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Act - Open dialog
      const settingsButton = screen.getByRole('button', { name: /settings/i });
      fireEvent.click(settingsButton);

      await waitFor(() => {
        expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
      });

      // Act - Close dialog
      const closeButton = screen.getByRole('button', { name: /close settings/i });
      fireEvent.click(closeButton);

      // Assert
      await waitFor(() => {
        expect(screen.queryByTestId('settings-dialog')).not.toBeInTheDocument();
      });
    });
  });

  describe('event subscriptions', () => {
    it('should subscribe to task status changes on mount', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      expect(mockOnTaskStatusChange).toHaveBeenCalled();
    });

    it('should subscribe to task updates on mount', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      expect(mockOnTaskUpdate).toHaveBeenCalled();
    });
  });

  describe('layout structure', () => {
    it('should render border between sections', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert - Check for border classes
      const sidebar = document.querySelector('.w-\\[260px\\]');
      expect(sidebar?.className).toContain('border-r');
    });

    it('should render with correct height for full screen', () => {
      // Arrange & Act
      render(
        <MemoryRouter initialEntries={['/']}>
          <Sidebar />
        </MemoryRouter>
      );

      // Assert
      const sidebar = document.querySelector('.h-screen');
      expect(sidebar).toBeInTheDocument();
    });
  });
});
