/**
 * Integration tests for Execution page
 * Tests rendering with active task, message display, and permission dialog
 * @module __tests__/integration/renderer/pages/Execution.integration.test
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Task, TaskStatus, TaskMessage, PermissionRequest } from '@accomplish/shared';

// Create mock functions
const mockLoadTaskById = vi.fn();
const mockAddTaskUpdate = vi.fn();
const mockAddTaskUpdateBatch = vi.fn();
const mockUpdateTaskStatus = vi.fn();
const mockSetPermissionRequest = vi.fn();
const mockRespondToPermission = vi.fn();
const mockSendFollowUp = vi.fn();
const mockCancelTask = vi.fn();
const mockInterruptTask = vi.fn();
const mockOnTaskUpdate = vi.fn();
const mockOnTaskUpdateBatch = vi.fn();
const mockOnPermissionRequest = vi.fn();
const mockOnTaskStatusChange = vi.fn();

// Helper to create mock task
function createMockTask(
  id: string,
  prompt: string = 'Test task',
  status: TaskStatus = 'running',
  messages: TaskMessage[] = []
): Task {
  return {
    id,
    prompt,
    status,
    messages,
    createdAt: new Date().toISOString(),
  };
}

// Helper to create mock message
function createMockMessage(
  id: string,
  type: 'assistant' | 'user' | 'tool' | 'system' = 'assistant',
  content: string = 'Test message'
): TaskMessage {
  return {
    id,
    type,
    content,
    timestamp: new Date().toISOString(),
  };
}

// Mock accomplish API
const mockAccomplish = {
  onTaskUpdate: mockOnTaskUpdate.mockReturnValue(() => {}),
  onTaskUpdateBatch: mockOnTaskUpdateBatch.mockReturnValue(() => {}),
  onPermissionRequest: mockOnPermissionRequest.mockReturnValue(() => {}),
  onTaskStatusChange: mockOnTaskStatusChange.mockReturnValue(() => {}),
  onDebugLog: vi.fn().mockReturnValue(() => {}),
  onDebugModeChange: vi.fn().mockReturnValue(() => {}),
  getSelectedModel: vi.fn().mockResolvedValue({ provider: 'anthropic', id: 'claude-3-opus' }),
  getOllamaConfig: vi.fn().mockResolvedValue(null),
  getDebugMode: vi.fn().mockResolvedValue(false),
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

// Mock store state holder
let mockStoreState: {
  currentTask: Task | null;
  loadTaskById: typeof mockLoadTaskById;
  isLoading: boolean;
  error: string | null;
  addTaskUpdate: typeof mockAddTaskUpdate;
  addTaskUpdateBatch: typeof mockAddTaskUpdateBatch;
  updateTaskStatus: typeof mockUpdateTaskStatus;
  setPermissionRequest: typeof mockSetPermissionRequest;
  permissionRequest: PermissionRequest | null;
  respondToPermission: typeof mockRespondToPermission;
  sendFollowUp: typeof mockSendFollowUp;
  cancelTask: typeof mockCancelTask;
  interruptTask: typeof mockInterruptTask;
  setupProgress: string | null;
  setupProgressTaskId: string | null;
  setupDownloadStep: number;
} = {
  currentTask: null,
  loadTaskById: mockLoadTaskById,
  isLoading: false,
  error: null,
  addTaskUpdate: mockAddTaskUpdate,
  addTaskUpdateBatch: mockAddTaskUpdateBatch,
  updateTaskStatus: mockUpdateTaskStatus,
  setPermissionRequest: mockSetPermissionRequest,
  permissionRequest: null,
  respondToPermission: mockRespondToPermission,
  sendFollowUp: mockSendFollowUp,
  cancelTask: mockCancelTask,
  interruptTask: mockInterruptTask,
  setupProgress: null,
  setupProgressTaskId: null,
  setupDownloadStep: 1,
};

// Mock the task store
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => mockStoreState,
}));

// Mock framer-motion for simpler testing
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

// Mock StreamingText component
vi.mock('@/components/ui/streaming-text', () => ({
  StreamingText: ({ text, children }: { text: string; children: (text: string) => React.ReactNode }) => (
    <>{children(text)}</>
  ),
}));

// Mock openwork icon
vi.mock('/assets/openwork-icon.png', () => ({ default: 'openwork-icon.png' }));

// Import after mocks
import ExecutionPage from '@/pages/Execution';

// Wrapper component for routing tests
function renderWithRouter(taskId: string = 'task-123') {
  return render(
    <MemoryRouter initialEntries={[`/execution/${taskId}`]}>
      <Routes>
        <Route path="/execution/:id" element={<ExecutionPage />} />
        <Route path="/" element={<div>Home Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Execution Page Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    mockStoreState = {
      currentTask: null,
      loadTaskById: mockLoadTaskById,
      isLoading: false,
      error: null,
      addTaskUpdate: mockAddTaskUpdate,
      addTaskUpdateBatch: mockAddTaskUpdateBatch,
      updateTaskStatus: mockUpdateTaskStatus,
      setPermissionRequest: mockSetPermissionRequest,
      permissionRequest: null,
      respondToPermission: mockRespondToPermission,
      sendFollowUp: mockSendFollowUp,
      cancelTask: mockCancelTask,
      interruptTask: mockInterruptTask,
      setupProgress: null,
      setupProgressTaskId: null,
      setupDownloadStep: 1,
    };
  });

  describe('rendering with active task', () => {
    it('should call loadTaskById on mount', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(mockLoadTaskById).toHaveBeenCalledWith('task-123');
    });

    it('should display loading spinner when no task loaded yet', () => {
      // Arrange - no current task

      // Act
      renderWithRouter('task-123');

      // Assert
      const spinner = document.querySelector('.animate-spin-ccw');
      expect(spinner).toBeInTheDocument();
    });

    it('should display task prompt in header', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Review my email inbox');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Review my email inbox')).toBeInTheDocument();
    });

    it('should display running status badge for running task', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Running task', 'running');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    it('should display completed status badge for completed task', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Done task', 'completed');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('should display failed status badge for failed task', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Failed task', 'failed');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });

    it('should display cancelled status badge for cancelled task', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Cancelled task', 'cancelled');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
    });

    it('should display queued status badge for queued task', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Queued task', 'queued');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Queued')).toBeInTheDocument();
    });

    it('should display stopped status badge for interrupted task', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Stopped task', 'interrupted');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Stopped')).toBeInTheDocument();
    });

    it('should render back button', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123');

      // Act
      renderWithRouter('task-123');

      // Assert - Look for the back arrow button
      const buttons = screen.getAllByRole('button');
      const backButton = buttons.find(btn => btn.querySelector('svg'));
      expect(backButton).toBeInTheDocument();
    });

    it('should not render cancel button (removed from UI)', () => {
      // Arrange - Cancel button was removed, only Stop button remains
      mockStoreState.currentTask = createMockTask('task-123', 'Running', 'running');

      // Act
      renderWithRouter('task-123');

      // Assert - Cancel button should not exist
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });

  describe('message display', () => {
    it('should display user messages', () => {
      // Arrange
      const messages = [
        createMockMessage('msg-1', 'user', 'Check my inbox'),
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Check my inbox')).toBeInTheDocument();
    });

    it('should display assistant messages', () => {
      // Arrange
      const messages = [
        createMockMessage('msg-1', 'assistant', 'I will check your inbox now.'),
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('I will check your inbox now.')).toBeInTheDocument();
    });

    it('should display tool messages with tool name', () => {
      // Arrange
      const messages: TaskMessage[] = [
        {
          id: 'msg-1',
          type: 'tool',
          content: 'Reading files',
          toolName: 'Read',
          timestamp: new Date().toISOString(),
        },
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Reading files')).toBeInTheDocument();
    });

    it('should display multiple messages in order', () => {
      // Arrange
      const messages = [
        createMockMessage('msg-1', 'user', 'First message'),
        createMockMessage('msg-2', 'assistant', 'Second message'),
        createMockMessage('msg-3', 'user', 'Third message'),
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('First message')).toBeInTheDocument();
      expect(screen.getByText('Second message')).toBeInTheDocument();
      expect(screen.getByText('Third message')).toBeInTheDocument();
    });

    it('should show "Thinking..." indicator when running without tool', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', []);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Thinking...')).toBeInTheDocument();
    });

    it('should display message timestamps', () => {
      // Arrange
      const timestamp = new Date().toISOString();
      const messages: TaskMessage[] = [
        {
          id: 'msg-1',
          type: 'assistant',
          content: 'Test message',
          timestamp,
        },
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'completed', messages);

      // Act
      renderWithRouter('task-123');

      // Assert - Check that a time is displayed
      const timeRegex = /\d{1,2}:\d{2}:\d{2}/;
      const timeElements = screen.getAllByText(timeRegex);
      expect(timeElements.length).toBeGreaterThan(0);
    });
  });

  describe('permission dialog', () => {
    it('should display permission dialog when permission request exists', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Permission Required')).toBeInTheDocument();
    });

    it('should display tool name in permission dialog', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'tool',
        toolName: 'Bash',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText(/tool:\s*bash/i)).toBeInTheDocument();
    });

    it('should render Allow and Deny buttons in permission dialog', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'tool',
        toolName: 'Write',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByRole('button', { name: /allow/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
    });

    it('should call respondToPermission with allow when Allow is clicked', async () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'tool',
        toolName: 'Write',
        createdAt: new Date().toISOString(),
      };

      renderWithRouter('task-123');

      // Act
      const allowButton = screen.getByRole('button', { name: /allow/i });
      fireEvent.click(allowButton);

      // Assert
      await waitFor(() => {
        expect(mockRespondToPermission).toHaveBeenCalledWith({
          requestId: 'perm-1',
          taskId: 'task-123',
          decision: 'allow',
        });
      });
    });

    it('should call respondToPermission with deny when Deny is clicked', async () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'tool',
        toolName: 'Write',
        createdAt: new Date().toISOString(),
      };

      renderWithRouter('task-123');

      // Act
      const denyButton = screen.getByRole('button', { name: /deny/i });
      fireEvent.click(denyButton);

      // Assert
      await waitFor(() => {
        expect(mockRespondToPermission).toHaveBeenCalledWith({
          requestId: 'perm-1',
          taskId: 'task-123',
          decision: 'deny',
        });
      });
    });

    it('should display file permission specific UI for file type', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'file',
        fileOperation: 'create',
        filePath: '/path/to/file.txt',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('File Permission Required')).toBeInTheDocument();
      expect(screen.getByText('CREATE')).toBeInTheDocument();
      expect(screen.getByText('/path/to/file.txt')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('should display error message when error exists', () => {
      // Arrange
      mockStoreState.error = 'Task not found';

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Task not found')).toBeInTheDocument();
    });

    it('should display Go Home button on error', () => {
      // Arrange
      mockStoreState.error = 'Something went wrong';

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByRole('button', { name: /go home/i })).toBeInTheDocument();
    });
  });

  describe('task controls', () => {
    it('should call interruptTask when Stop button is clicked', async () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Running', 'running');

      renderWithRouter('task-123');

      // Act - Find the stop button (square icon)
      const stopButton = screen.getByTitle(/stop agent/i);
      fireEvent.click(stopButton);

      // Assert
      await waitFor(() => {
        expect(mockInterruptTask).toHaveBeenCalled();
      });
    });
  });

  describe('follow-up input', () => {
    it('should show follow-up input for completed task with session', () => {
      // Arrange
      const task = createMockTask('task-123', 'Done', 'completed');
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByPlaceholderText(/give new instructions/i)).toBeInTheDocument();
    });

    it('should show follow-up input for interrupted task with session', () => {
      // Arrange
      const task = createMockTask('task-123', 'Stopped', 'interrupted');
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByPlaceholderText(/give new instructions/i)).toBeInTheDocument();
    });

    it('should show "Start New Task" button for completed task without session', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Done', 'completed');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByRole('button', { name: /start new task/i })).toBeInTheDocument();
    });

    it('should call sendFollowUp when follow-up is submitted', async () => {
      // Arrange
      const task = createMockTask('task-123', 'Done', 'completed');
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      renderWithRouter('task-123');

      // Act
      const input = screen.getByPlaceholderText(/give new instructions/i);
      fireEvent.change(input, { target: { value: 'Continue with the next step' } });

      const sendButton = screen.getByRole('button', { name: /send/i });
      fireEvent.click(sendButton);

      // Assert
      await waitFor(() => {
        expect(mockSendFollowUp).toHaveBeenCalledWith('Continue with the next step');
      });
    });

    it('should call sendFollowUp when Enter is pressed', async () => {
      // Arrange
      const task = createMockTask('task-123', 'Done', 'completed');
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      renderWithRouter('task-123');

      // Act
      const input = screen.getByPlaceholderText(/give new instructions/i);
      fireEvent.change(input, { target: { value: 'Do more work' } });
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

      // Assert
      await waitFor(() => {
        expect(mockSendFollowUp).toHaveBeenCalledWith('Do more work');
      });
    });

    it('should disable follow-up input when loading', () => {
      // Arrange
      const task = createMockTask('task-123', 'Done', 'completed');
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;
      mockStoreState.isLoading = true;

      // Act
      renderWithRouter('task-123');

      // Assert
      const input = screen.getByPlaceholderText(/give new instructions/i);
      expect(input).toBeDisabled();
    });

    it('should disable send button when follow-up is empty', () => {
      // Arrange
      const task = createMockTask('task-123', 'Done', 'completed');
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      // Act
      renderWithRouter('task-123');

      // Assert
      const sendButton = screen.getByRole('button', { name: /send/i });
      expect(sendButton).toBeDisabled();
    });
  });

  describe('queued state', () => {
    it('should show waiting message for queued task without messages', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Queued task', 'queued');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText(/waiting for another task/i)).toBeInTheDocument();
    });

    it('should show inline waiting indicator for queued task with messages', () => {
      // Arrange
      const messages = [
        createMockMessage('msg-1', 'user', 'Previous message'),
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Queued', 'queued', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Previous message')).toBeInTheDocument();
      expect(screen.getByText(/waiting for another task/i)).toBeInTheDocument();
    });
  });

  describe('event subscriptions', () => {
    it('should subscribe to task updates on mount', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(mockOnTaskUpdate).toHaveBeenCalled();
    });

    it('should subscribe to task update batches on mount', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(mockOnTaskUpdateBatch).toHaveBeenCalled();
    });

    it('should subscribe to permission requests on mount', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(mockOnPermissionRequest).toHaveBeenCalled();
    });

    it('should subscribe to task status changes on mount', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(mockOnTaskStatusChange).toHaveBeenCalled();
    });
  });

  describe('browser installation modal', () => {
    it('should show download modal when setupProgress contains "download"', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.setupProgress = 'Downloading Chromium 50%';
      mockStoreState.setupProgressTaskId = 'task-123';
      mockStoreState.setupDownloadStep = 1;

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Chrome not installed')).toBeInTheDocument();
      expect(screen.getByText('Installing browser for automation...')).toBeInTheDocument();
      expect(screen.getByText('Downloading...')).toBeInTheDocument();
    });

    it('should show download modal when setupProgress contains "% of"', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.setupProgress = '50% of 160 MB';
      mockStoreState.setupProgressTaskId = 'task-123';
      mockStoreState.setupDownloadStep = 1;

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Chrome not installed')).toBeInTheDocument();
    });

    it('should calculate overall progress for step 1 (Chromium)', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.setupProgress = 'Downloading 50%';
      mockStoreState.setupProgressTaskId = 'task-123';
      mockStoreState.setupDownloadStep = 1;

      // Act
      renderWithRouter('task-123');

      // Assert - 50% * 0.64 = 32%
      expect(screen.getByText('32%')).toBeInTheDocument();
    });

    it('should calculate overall progress for step 2 (FFMPEG)', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.setupProgress = 'Downloading 50%';
      mockStoreState.setupProgressTaskId = 'task-123';
      mockStoreState.setupDownloadStep = 2;

      // Act
      renderWithRouter('task-123');

      // Assert - 64 + Math.round(50 * 0.01) = 64 + 1 = 65%
      expect(screen.getByText('65%')).toBeInTheDocument();
    });

    it('should calculate overall progress for step 3 (Headless)', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.setupProgress = 'Downloading 50%';
      mockStoreState.setupProgressTaskId = 'task-123';
      mockStoreState.setupDownloadStep = 3;

      // Act
      renderWithRouter('task-123');

      // Assert - 65 + Math.round(50 * 0.35) = 65 + 18 = 83%
      expect(screen.getByText('83%')).toBeInTheDocument();
    });

    it('should not show download modal for different task', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.setupProgress = 'Downloading 50%';
      mockStoreState.setupProgressTaskId = 'different-task';
      mockStoreState.setupDownloadStep = 1;

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.queryByText('Chrome not installed')).not.toBeInTheDocument();
    });

    it('should not show download modal when setupProgress is null', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.setupProgress = null;
      mockStoreState.setupProgressTaskId = 'task-123';

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.queryByText('Chrome not installed')).not.toBeInTheDocument();
    });

    it('should show one-time setup message', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.setupProgress = 'Downloading 50%';
      mockStoreState.setupProgressTaskId = 'task-123';
      mockStoreState.setupDownloadStep = 1;

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText(/one-time setup/i)).toBeInTheDocument();
      expect(screen.getByText(/~250 MB total/i)).toBeInTheDocument();
    });
  });

  describe('file permission dialog details', () => {
    it('should show target path for rename/move operations', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'file',
        fileOperation: 'rename',
        filePath: '/path/to/old.txt',
        targetPath: '/path/to/new.txt',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('/path/to/old.txt')).toBeInTheDocument();
      expect(screen.getByText(/new\.txt/)).toBeInTheDocument();
    });

    it('should show content preview for file operations', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'file',
        fileOperation: 'create',
        filePath: '/path/to/file.txt',
        contentPreview: 'This is the file content preview...',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Preview content')).toBeInTheDocument();
    });

    it('should show delete operation warning UI', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'file',
        fileOperation: 'delete',
        filePath: '/path/to/file.txt',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert - delete operations show warning UI with title and button, not a badge
      expect(screen.getByText('File Deletion Warning')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('should show overwrite operation badge', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'file',
        fileOperation: 'overwrite',
        filePath: '/path/to/file.txt',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('OVERWRITE')).toBeInTheDocument();
    });

    it('should show modify operation badge', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'file',
        fileOperation: 'modify',
        filePath: '/path/to/file.txt',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('MODIFY')).toBeInTheDocument();
    });

    it('should show move operation badge', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'file',
        fileOperation: 'move',
        filePath: '/path/to/file.txt',
        targetPath: '/new/path/file.txt',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('MOVE')).toBeInTheDocument();
    });

    it('should show tool name in tool permission dialog', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running');
      mockStoreState.permissionRequest = {
        id: 'perm-1',
        taskId: 'task-123',
        type: 'tool',
        toolName: 'Bash',
        createdAt: new Date().toISOString(),
      };

      // Act
      renderWithRouter('task-123');

      // Assert - Tool permission UI shows "Allow {toolName}?"
      expect(screen.getByText('Allow Bash?')).toBeInTheDocument();
    });
  });

  describe('task complete states', () => {
    it('should navigate home when clicking Start New Task for failed task without session', async () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Failed', 'failed');

      // Act
      renderWithRouter('task-123');

      // Assert
      const startNewButton = screen.getByRole('button', { name: /start new task/i });
      expect(startNewButton).toBeInTheDocument();

      // Click the button - it should navigate to home
      fireEvent.click(startNewButton);

      // Verify navigation happened by checking for Home Page text
      await waitFor(() => {
        expect(screen.getByText('Home Page')).toBeInTheDocument();
      });
    });

    it('should show follow-up input for interrupted task', () => {
      // Arrange - interrupted task without session still shows follow-up
      mockStoreState.currentTask = createMockTask('task-123', 'Stopped', 'interrupted');

      // Act
      renderWithRouter('task-123');

      // Assert - canFollowUp is true for interrupted status
      // Look for the retry placeholder text
      expect(screen.getByPlaceholderText(/send a new instruction to retry/i)).toBeInTheDocument();
    });

    it('should show task cancelled message for cancelled task', () => {
      // Arrange
      mockStoreState.currentTask = createMockTask('task-123', 'Cancelled', 'cancelled');

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText(/task cancelled/i)).toBeInTheDocument();
    });

    it('should show Continue button for interrupted task with session and messages', () => {
      // Arrange
      const messages = [
        createMockMessage('msg-1', 'assistant', 'I was working on something'),
      ];
      const task = createMockTask('task-123', 'Stopped', 'interrupted', messages);
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
    });

    it('should show Done Continue button for completed task with session when waiting for user', () => {
      // Arrange - message must contain a "waiting for user" pattern to show Done, Continue button
      const messages = [
        createMockMessage('msg-1', 'assistant', 'Please log in to your account. Let me know when you are done.'),
      ];
      const task = createMockTask('task-123', 'Done', 'completed', messages);
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      // Act
      renderWithRouter('task-123');

      // Assert - button shows because isWaitingForUser() returns true for this message
      expect(screen.getByRole('button', { name: /done, continue/i })).toBeInTheDocument();
    });

    it('should call sendFollowUp with continue when Continue button is clicked', async () => {
      // Arrange
      const messages = [
        createMockMessage('msg-1', 'assistant', 'I was working on something'),
      ];
      const task = createMockTask('task-123', 'Stopped', 'interrupted', messages);
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      renderWithRouter('task-123');

      // Act
      const continueButton = screen.getByRole('button', { name: /continue/i });
      fireEvent.click(continueButton);

      // Assert
      await waitFor(() => {
        expect(mockSendFollowUp).toHaveBeenCalledWith('continue');
      });
    });
  });

  describe('system messages', () => {
    it('should display system messages with System label', () => {
      // Arrange
      const messages = [
        createMockMessage('msg-1', 'system', 'System initialization complete'),
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('System')).toBeInTheDocument();
      expect(screen.getByText('System initialization complete')).toBeInTheDocument();
    });
  });

  describe('default status badge', () => {
    it('should display raw status for unknown status', () => {
      // Arrange
      const task = createMockTask('task-123', 'Task', 'unknown' as TaskStatus);
      mockStoreState.currentTask = task;

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('unknown')).toBeInTheDocument();
    });
  });

  describe('tool message icons', () => {
    it('should display Glob tool with search icon label', () => {
      // Arrange
      const messages: TaskMessage[] = [
        {
          id: 'msg-1',
          type: 'tool',
          content: 'Finding files',
          toolName: 'Glob',
          timestamp: new Date().toISOString(),
        },
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Finding files')).toBeInTheDocument();
    });

    it('should display Grep tool with search label', () => {
      // Arrange
      const messages: TaskMessage[] = [
        {
          id: 'msg-1',
          type: 'tool',
          content: 'Searching code',
          toolName: 'Grep',
          timestamp: new Date().toISOString(),
        },
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Searching code')).toBeInTheDocument();
    });

    it('should display Write tool', () => {
      // Arrange
      const messages: TaskMessage[] = [
        {
          id: 'msg-1',
          type: 'tool',
          content: 'Writing file',
          toolName: 'Write',
          timestamp: new Date().toISOString(),
        },
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Writing file')).toBeInTheDocument();
    });

    it('should display Edit tool', () => {
      // Arrange
      const messages: TaskMessage[] = [
        {
          id: 'msg-1',
          type: 'tool',
          content: 'Editing file',
          toolName: 'Edit',
          timestamp: new Date().toISOString(),
        },
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Editing file')).toBeInTheDocument();
    });

    it('should display Task agent tool', () => {
      // Arrange
      const messages: TaskMessage[] = [
        {
          id: 'msg-1',
          type: 'tool',
          content: 'Running agent',
          toolName: 'Task',
          timestamp: new Date().toISOString(),
        },
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Running agent')).toBeInTheDocument();
    });

    it('should display dev_browser_execute tool', () => {
      // Arrange
      const messages: TaskMessage[] = [
        {
          id: 'msg-1',
          type: 'tool',
          content: 'Executing browser action',
          toolName: 'dev_browser_execute',
          timestamp: new Date().toISOString(),
        },
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('Executing browser action')).toBeInTheDocument();
    });

    it('should display unknown tool with fallback icon', () => {
      // Arrange
      const messages: TaskMessage[] = [
        {
          id: 'msg-1',
          type: 'tool',
          content: 'Unknown operation',
          toolName: 'CustomTool',
          timestamp: new Date().toISOString(),
        },
      ];
      mockStoreState.currentTask = createMockTask('task-123', 'Task', 'running', messages);

      // Act
      renderWithRouter('task-123');

      // Assert
      expect(screen.getByText('CustomTool')).toBeInTheDocument();
    });
  });


  describe('follow-up placeholder text variations', () => {
    it('should show follow-up input for interrupted task even without session', () => {
      // Arrange
      const task = createMockTask('task-123', 'Stopped', 'interrupted');
      // No sessionId - but canFollowUp is true for interrupted status
      mockStoreState.currentTask = task;

      // Act
      renderWithRouter('task-123');

      // Assert - for interrupted, follow-up input is shown even without session
      // The placeholder says "Send a new instruction to retry..."
      const input = screen.getByPlaceholderText(/send a new instruction to retry/i);
      expect(input).toBeInTheDocument();
    });

    it('should show retry placeholder for interrupted task with session', () => {
      // Arrange
      const task = createMockTask('task-123', 'Stopped', 'interrupted');
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      // Act
      renderWithRouter('task-123');

      // Assert
      const input = screen.getByPlaceholderText(/give new instructions/i);
      expect(input).toBeInTheDocument();
    });
  });

  describe('error navigation', () => {
    it('should navigate home when Go Home button is clicked', async () => {
      // Arrange
      mockStoreState.error = 'Task not found';

      // Act
      renderWithRouter('task-123');

      const goHomeButton = screen.getByRole('button', { name: /go home/i });
      fireEvent.click(goHomeButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Home Page')).toBeInTheDocument();
      });
    });
  });

  describe('follow-up input empty check', () => {
    it('should not call sendFollowUp when follow-up is only whitespace', async () => {
      // Arrange
      const task = createMockTask('task-123', 'Done', 'completed');
      task.sessionId = 'session-abc';
      mockStoreState.currentTask = task;

      renderWithRouter('task-123');

      // Act
      const input = screen.getByPlaceholderText(/give new instructions/i);
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

      // Assert
      await waitFor(() => {
        expect(mockSendFollowUp).not.toHaveBeenCalled();
      });
    });
  });
});
