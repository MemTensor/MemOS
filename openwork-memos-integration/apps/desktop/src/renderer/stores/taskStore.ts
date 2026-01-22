import { create } from 'zustand';
import type {
  Task,
  TaskConfig,
  TaskStatus,
  TaskUpdateEvent,
  PermissionRequest,
  PermissionResponse,
  TaskMessage,
} from '@accomplish/shared';
import { getAccomplish } from '../lib/accomplish';

// Batch update event type for performance optimization
interface TaskUpdateBatchEvent {
  taskId: string;
  messages: TaskMessage[];
}

// Setup progress event type
interface SetupProgressEvent {
  taskId: string;
  stage: string;
  message?: string;
}

interface TaskState {
  // Current task
  currentTask: Task | null;
  isLoading: boolean;
  error: string | null;

  // Task history
  tasks: Task[];

  // Permission handling
  permissionRequest: PermissionRequest | null;

  // Setup progress (e.g., browser download)
  setupProgress: string | null;
  setupProgressTaskId: string | null;
  setupDownloadStep: number; // 1=Chromium, 2=FFMPEG, 3=Headless Shell

  // Task launcher
  isLauncherOpen: boolean;
  openLauncher: () => void;
  closeLauncher: () => void;

  // Actions
  startTask: (config: TaskConfig) => Promise<Task | null>;
  setSetupProgress: (taskId: string | null, message: string | null) => void;
  sendFollowUp: (message: string) => Promise<void>;
  cancelTask: () => Promise<void>;
  interruptTask: () => Promise<void>;
  setPermissionRequest: (request: PermissionRequest | null) => void;
  respondToPermission: (response: PermissionResponse) => Promise<void>;
  addTaskUpdate: (event: TaskUpdateEvent) => void;
  addTaskUpdateBatch: (event: TaskUpdateBatchEvent) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  setTaskSummary: (taskId: string, summary: string) => void;
  loadTasks: () => Promise<void>;
  loadTaskById: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  reset: () => void;
}

function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  currentTask: null,
  isLoading: false,
  error: null,
  tasks: [],
  permissionRequest: null,
  setupProgress: null,
  setupProgressTaskId: null,
  setupDownloadStep: 1,
  isLauncherOpen: false,

  setSetupProgress: (taskId: string | null, message: string | null) => {
    // Detect which package is being downloaded from the message
    let step = useTaskStore.getState().setupDownloadStep;
    if (message) {
      const lowerMsg = message.toLowerCase();
      if (lowerMsg.includes('downloading chromium headless')) {
        step = 3;
      } else if (lowerMsg.includes('downloading ffmpeg')) {
        step = 2;
      } else if (lowerMsg.includes('downloading chromium')) {
        step = 1;
      }
    }
    set({ setupProgress: message, setupProgressTaskId: taskId, setupDownloadStep: step });
  },

  startTask: async (config: TaskConfig) => {
    const accomplish = getAccomplish();
    set({ isLoading: true, error: null });
    try {
      void accomplish.logEvent({
        level: 'info',
        message: 'UI start task',
        context: { prompt: config.prompt, taskId: config.taskId },
      });
      const task = await accomplish.startTask(config);
      // Task might be 'running' or 'queued' depending on if another task is running
      // Also add to tasks list so sidebar updates immediately
      const currentTasks = get().tasks;
      set({
        currentTask: task,
        tasks: [task, ...currentTasks.filter((t) => t.id !== task.id)],
        // Keep loading state if queued (waiting for queue)
        isLoading: task.status === 'queued',
      });
      void accomplish.logEvent({
        level: 'info',
        message: task.status === 'queued' ? 'UI task queued' : 'UI task started',
        context: { taskId: task.id, status: task.status },
      });
      return task;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to start task',
        isLoading: false,
      });
      void accomplish.logEvent({
        level: 'error',
        message: 'UI task start failed',
        context: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  },

  sendFollowUp: async (message: string) => {
    const accomplish = getAccomplish();
    const { currentTask, startTask } = get();
    if (!currentTask) {
      set({ error: 'No active task to continue' });
      void accomplish.logEvent({
        level: 'warn',
        message: 'UI follow-up failed: no active task',
      });
      return;
    }

    const sessionId = currentTask.result?.sessionId || currentTask.sessionId;

    // If no session but task was interrupted, start a fresh task with the new message
    if (!sessionId && currentTask.status === 'interrupted') {
      void accomplish.logEvent({
        level: 'info',
        message: 'UI follow-up: starting fresh task (no session from interrupted task)',
        context: { taskId: currentTask.id },
      });
      await startTask({ prompt: message });
      return;
    }

    if (!sessionId) {
      set({ error: 'No session to continue - please start a new task' });
      void accomplish.logEvent({
        level: 'warn',
        message: 'UI follow-up failed: missing session',
        context: { taskId: currentTask.id },
      });
      return;
    }

    const userMessage: TaskMessage = {
      id: createMessageId(),
      type: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };

    // Optimistically add user message and set status to running
    const taskId = currentTask.id;
    set((state) => ({
      isLoading: true,
      error: null,
      currentTask: state.currentTask
        ? {
            ...state.currentTask,
            status: 'running',
            result: undefined,
            messages: [...state.currentTask.messages, userMessage],
          }
        : null,
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'running' as TaskStatus } : t
      ),
    }));

    try {
      void accomplish.logEvent({
        level: 'info',
        message: 'UI follow-up sent',
        context: { taskId: currentTask.id, message },
      });
      const task = await accomplish.resumeSession(sessionId, message, currentTask.id);

      // Update status based on response (could be 'running' or 'queued')
      set((state) => ({
        currentTask: state.currentTask
          ? { ...state.currentTask, status: task.status }
          : null,
        isLoading: task.status === 'queued',
        tasks: state.tasks.map((t) =>
          t.id === taskId ? { ...t, status: task.status } : t
        ),
      }));
    } catch (err) {
      set((state) => ({
        error: err instanceof Error ? err.message : 'Failed to send message',
        isLoading: false,
        currentTask: state.currentTask
          ? { ...state.currentTask, status: 'failed' }
          : null,
        tasks: state.tasks.map((t) =>
          t.id === taskId ? { ...t, status: 'failed' as TaskStatus } : t
        ),
      }));
      void accomplish.logEvent({
        level: 'error',
        message: 'UI follow-up failed',
        context: { taskId: currentTask.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  },

  cancelTask: async () => {
    const accomplish = getAccomplish();
    const { currentTask } = get();
    if (currentTask) {
      void accomplish.logEvent({
        level: 'info',
        message: 'UI cancel task',
        context: { taskId: currentTask.id },
      });
      await accomplish.cancelTask(currentTask.id);
      set((state) => ({
        currentTask: state.currentTask
          ? { ...state.currentTask, status: 'cancelled' }
          : null,
        tasks: state.tasks.map((t) =>
          t.id === currentTask.id ? { ...t, status: 'cancelled' as TaskStatus } : t
        ),
      }));
    }
  },

  interruptTask: async () => {
    const accomplish = getAccomplish();
    const { currentTask } = get();
    if (currentTask && currentTask.status === 'running') {
      void accomplish.logEvent({
        level: 'info',
        message: 'UI interrupt task',
        context: { taskId: currentTask.id },
      });
      await accomplish.interruptTask(currentTask.id);
      // Note: Don't change task status - task is still running, just interrupted
    }
  },

  setPermissionRequest: (request) => {
    set({ permissionRequest: request });
  },

  respondToPermission: async (response: PermissionResponse) => {
    const accomplish = getAccomplish();
    void accomplish.logEvent({
      level: 'info',
      message: 'UI permission response',
      context: { ...response },
    });
    await accomplish.respondToPermission(response);
    set({ permissionRequest: null });
  },

  addTaskUpdate: (event: TaskUpdateEvent) => {
    const accomplish = getAccomplish();
    void accomplish.logEvent({
      level: 'debug',
      message: 'UI task update received',
      context: { ...event },
    });
    set((state) => {
      // Determine if this event is for the currently viewed task
      const isCurrentTask = state.currentTask?.id === event.taskId;

      // Start with current state
      let updatedCurrentTask = state.currentTask;
      let updatedTasks = state.tasks;
      let newStatus: TaskStatus | null = null;

      // Handle message events - only if viewing this task
      if (event.type === 'message' && event.message && isCurrentTask && state.currentTask) {
        updatedCurrentTask = {
          ...state.currentTask,
          messages: [...state.currentTask.messages, event.message],
        };
      }

      // Handle complete events
      if (event.type === 'complete' && event.result) {
        // Map result status to task status
        if (event.result.status === 'success') {
          newStatus = 'completed';
        } else if (event.result.status === 'interrupted') {
          newStatus = 'interrupted';
        } else {
          newStatus = 'failed';
        }

        // Update currentTask if viewing this task
        if (isCurrentTask && state.currentTask) {
          updatedCurrentTask = {
            ...state.currentTask,
            status: newStatus,
            result: event.result,
            // Don't set completedAt for interrupted tasks - they can continue
            completedAt: newStatus === 'interrupted' ? undefined : new Date().toISOString(),
            sessionId: event.result.sessionId || state.currentTask.sessionId,
          };
        }
      }

      // Handle error events
      if (event.type === 'error') {
        newStatus = 'failed';

        // Update currentTask if viewing this task
        if (isCurrentTask && state.currentTask) {
          updatedCurrentTask = {
            ...state.currentTask,
            status: newStatus,
            result: { status: 'error', error: event.error },
          };
        }
      }

      // Always update sidebar tasks list if status changed
      if (newStatus) {
        const finalStatus = newStatus;
        updatedTasks = state.tasks.map((t) =>
          t.id === event.taskId ? { ...t, status: finalStatus } : t
        );
      }

      return {
        currentTask: updatedCurrentTask,
        tasks: updatedTasks,
        isLoading: false,
      };
    });
  },

  // Batch update handler for performance - processes multiple messages in single state update
  addTaskUpdateBatch: (event: TaskUpdateBatchEvent) => {
    const accomplish = getAccomplish();
    void accomplish.logEvent({
      level: 'debug',
      message: 'UI task batch update received',
      context: { taskId: event.taskId, messageCount: event.messages.length },
    });
    set((state) => {
      if (!state.currentTask || state.currentTask.id !== event.taskId) {
        return state;
      }

      // Add all messages in a single state update
      const updatedTask = {
        ...state.currentTask,
        messages: [...state.currentTask.messages, ...event.messages],
      };

      return { currentTask: updatedTask, isLoading: false };
    });
  },

  // Update task status (e.g., queued -> running)
  updateTaskStatus: (taskId: string, status: TaskStatus) => {
    set((state) => {
      // Update in tasks list
      const updatedTasks = state.tasks.map((task) =>
        task.id === taskId
          ? { ...task, status, updatedAt: new Date().toISOString() }
          : task
      );

      // Update currentTask if it matches
      const updatedCurrentTask =
        state.currentTask?.id === taskId
          ? { ...state.currentTask, status, updatedAt: new Date().toISOString() }
          : state.currentTask;

      return {
        tasks: updatedTasks,
        currentTask: updatedCurrentTask,
      };
    });
  },

  // Update task summary (AI-generated)
  setTaskSummary: (taskId: string, summary: string) => {
    set((state) => {
      // Update in tasks list
      const updatedTasks = state.tasks.map((task) =>
        task.id === taskId ? { ...task, summary } : task
      );

      // Update currentTask if it matches
      const updatedCurrentTask =
        state.currentTask?.id === taskId
          ? { ...state.currentTask, summary }
          : state.currentTask;

      return {
        tasks: updatedTasks,
        currentTask: updatedCurrentTask,
      };
    });
  },

  loadTasks: async () => {
    const accomplish = getAccomplish();
    const tasks = await accomplish.listTasks();
    set({ tasks });
  },

  loadTaskById: async (taskId: string) => {
    const accomplish = getAccomplish();
    const task = await accomplish.getTask(taskId);
    set({ currentTask: task, error: task ? null : 'Task not found' });
  },

  deleteTask: async (taskId: string) => {
    const accomplish = getAccomplish();
    await accomplish.deleteTask(taskId);
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    }));
  },

  clearHistory: async () => {
    const accomplish = getAccomplish();
    await accomplish.clearTaskHistory();
    set({ tasks: [] });
  },

  reset: () => {
    set({
      currentTask: null,
      isLoading: false,
      error: null,
      permissionRequest: null,
      setupProgress: null,
      setupProgressTaskId: null,
      setupDownloadStep: 1,
      isLauncherOpen: false,
    });
  },

  openLauncher: () => set({ isLauncherOpen: true }),
  closeLauncher: () => set({ isLauncherOpen: false }),
}));

// Global subscription to setup progress events (browser download, etc.)
// This runs when the module is loaded to catch early progress events
if (typeof window !== 'undefined' && window.accomplish) {
  window.accomplish.onTaskProgress((progress: unknown) => {
    const event = progress as SetupProgressEvent;
    if (event.message) {
      // Clear progress if installation completed
      if (event.message.toLowerCase().includes('installed successfully')) {
        useTaskStore.getState().setSetupProgress(null, null);
      } else {
        useTaskStore.getState().setSetupProgress(event.taskId, event.message);
      }
    }
  });

  // Clear progress when task completes or errors (not on messages - download continues during messages)
  window.accomplish.onTaskUpdate((event: unknown) => {
    const updateEvent = event as TaskUpdateEvent;
    if (updateEvent.type === 'complete' || updateEvent.type === 'error') {
      const state = useTaskStore.getState();
      if (state.setupProgressTaskId === updateEvent.taskId) {
        state.setSetupProgress(null, null);
      }
    }
  });

  // Subscribe to task summary updates
  window.accomplish.onTaskSummary?.(( data: { taskId: string; summary: string }) => {
    useTaskStore.getState().setTaskSummary(data.taskId, data.summary);
  });
}
