/**
 * Integration tests for App component
 * Tests router setup and route rendering
 *
 * NOTE: This test follows React component integration testing principles:
 * - Mocks external boundaries (IPC API, analytics) - cannot run real Electron in vitest
 * - Mocks animation libraries (framer-motion) - for test stability
 * - Mocks child page components - to focus on App's coordination logic
 * - Uses real router (MemoryRouter) for route testing
 *
 * For full component rendering integration, see individual component tests.
 *
 * @module __tests__/integration/renderer/App.integration.test
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Create mock functions for accomplish API
const mockSetOnboardingComplete = vi.fn();
const mockLogEvent = vi.fn();
const mockListTasks = vi.fn();
const mockOnTaskStatusChange = vi.fn();
const mockOnTaskUpdate = vi.fn();
const mockGetTask = vi.fn();

// Mock accomplish API
const mockAccomplish = {
  setOnboardingComplete: mockSetOnboardingComplete,
  logEvent: mockLogEvent.mockResolvedValue(undefined),
  listTasks: mockListTasks.mockResolvedValue([]),
  onTaskStatusChange: mockOnTaskStatusChange.mockReturnValue(() => {}),
  onTaskUpdate: mockOnTaskUpdate.mockReturnValue(() => {}),
  getTask: mockGetTask.mockResolvedValue(null),
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

// Mock the accomplish module - always return true for isRunningInElectron for most tests
vi.mock('@/lib/accomplish', () => ({
  getAccomplish: () => mockAccomplish,
  isRunningInElectron: () => true,
}));

// Mock analytics
vi.mock('@/lib/analytics', () => ({
  analytics: {
    trackPageView: vi.fn(),
    trackNewTask: vi.fn(),
    trackOpenSettings: vi.fn(),
  },
}));

// Mock framer-motion to simplify testing animations
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, className, ...props }: { children: React.ReactNode; className?: string; [key: string]: unknown }) => {
      const { initial, animate, exit, transition, variants, whileHover, ...domProps } = props;
      return <div className={className} {...domProps}>{children}</div>;
    },
    p: ({ children, className, ...props }: { children: React.ReactNode; className?: string; [key: string]: unknown }) => {
      const { initial, animate, exit, transition, variants, ...domProps } = props;
      return <p className={className} {...domProps}>{children}</p>;
    },
    button: ({ children, className, ...props }: { children: React.ReactNode; className?: string; [key: string]: unknown }) => {
      const { initial, animate, exit, transition, variants, whileHover, ...domProps } = props;
      return <button className={className} {...domProps}>{children}</button>;
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock animation utilities
vi.mock('@/lib/animations', () => ({
  springs: {
    bouncy: { type: 'spring', stiffness: 300 },
    gentle: { type: 'spring', stiffness: 200 },
  },
  variants: {
    fadeUp: {
      initial: { opacity: 0, y: 20 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -20 },
    },
  },
  staggerContainer: {},
  staggerItem: {},
}));

// Mock the task store
const mockLoadTasks = vi.fn();
const mockReset = vi.fn();
let mockStoreState = {
  tasks: [],
  currentTask: null,
  isLoading: false,
  loadTasks: mockLoadTasks,
  reset: mockReset,
  loadTaskById: vi.fn(),
  updateTaskStatus: vi.fn(),
  addTaskUpdate: vi.fn(),
};

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => mockStoreState,
}));

// Mock the Sidebar component
vi.mock('@/components/layout/Sidebar', () => ({
  default: () => <div data-testid="sidebar">Sidebar</div>,
}));

// Mock the HomePage
vi.mock('@/pages/Home', () => ({
  default: () => <div data-testid="home-page">Home Page Content</div>,
}));

// Mock the ExecutionPage
vi.mock('@/pages/Execution', () => ({
  default: () => <div data-testid="execution-page">Execution Page Content</div>,
}));

// Import App after all mocks are set up
import App from '@/App';

describe('App Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    mockStoreState = {
      tasks: [],
      currentTask: null,
      isLoading: false,
      loadTasks: mockLoadTasks,
      reset: mockReset,
      loadTaskById: vi.fn(),
      updateTaskStatus: vi.fn(),
      addTaskUpdate: vi.fn(),
    };
    mockSetOnboardingComplete.mockResolvedValue(undefined);
  });

  // Helper to render App with router
  const renderApp = (initialRoute = '/') => {
    return render(
      <MemoryRouter initialEntries={[initialRoute]}>
        <App />
      </MemoryRouter>
    );
  };

  describe('router setup', () => {
    it('should render sidebar in ready state', async () => {
      // Arrange & Act
      renderApp();

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('sidebar')).toBeInTheDocument();
      });
    });

    it('should render main content area', async () => {
      // Arrange & Act
      renderApp();

      // Assert
      await waitFor(() => {
        const main = document.querySelector('main');
        expect(main).toBeInTheDocument();
      });
    });

    it('should render drag region for window dragging', async () => {
      // Arrange & Act
      renderApp();

      // Assert
      await waitFor(() => {
        const dragRegion = document.querySelector('.drag-region');
        expect(dragRegion).toBeInTheDocument();
      });
    });
  });

  describe('route rendering - Home', () => {
    it('should render home page at root route', async () => {
      // Arrange & Act
      renderApp('/');

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('home-page')).toBeInTheDocument();
      });
    });

    it('should render home page content', async () => {
      // Arrange & Act
      renderApp('/');

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Home Page Content')).toBeInTheDocument();
      });
    });
  });

  describe('route rendering - Execution', () => {
    it('should render execution page at /execution/:id route', async () => {
      // Arrange & Act
      renderApp('/execution/task-123');

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('execution-page')).toBeInTheDocument();
      });
    });

    it('should render execution page content', async () => {
      // Arrange & Act
      renderApp('/execution/task-123');

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Execution Page Content')).toBeInTheDocument();
      });
    });

    it('should handle different task IDs', async () => {
      // Arrange & Act
      renderApp('/execution/different-task-456');

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('execution-page')).toBeInTheDocument();
      });
    });
  });

  describe('route rendering - Fallback', () => {
    it('should redirect unknown routes to home', async () => {
      // Arrange & Act
      renderApp('/unknown-route');

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('home-page')).toBeInTheDocument();
      });
    });

    it('should redirect /history to home (since it is not defined)', async () => {
      // Arrange & Act
      renderApp('/history');

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('home-page')).toBeInTheDocument();
      });
    });

    it('should redirect deeply nested unknown routes to home', async () => {
      // Arrange & Act
      renderApp('/some/deeply/nested/route');

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('home-page')).toBeInTheDocument();
      });
    });
  });

  describe('layout structure', () => {
    it('should render with flex layout', async () => {
      // Arrange & Act
      renderApp();

      // Assert
      await waitFor(() => {
        const flexContainer = document.querySelector('.flex.h-screen');
        expect(flexContainer).toBeInTheDocument();
      });
    });

    it('should prevent overflow on app container', async () => {
      // Arrange & Act
      renderApp();

      // Assert
      await waitFor(() => {
        const container = document.querySelector('.overflow-hidden');
        expect(container).toBeInTheDocument();
      });
    });

    it('should render main content with flex-1 for proper sizing', async () => {
      // Arrange & Act
      renderApp();

      // Assert
      await waitFor(() => {
        const main = document.querySelector('main.flex-1');
        expect(main).toBeInTheDocument();
      });
    });
  });

  describe('analytics tracking', () => {
    it('should track page view on mount', async () => {
      // Arrange
      const { analytics } = await import('@/lib/analytics');

      // Act
      renderApp('/');

      // Assert
      await waitFor(() => {
        expect(analytics.trackPageView).toHaveBeenCalledWith('/');
      });
    });

    it('should track page view for execution route', async () => {
      // Arrange
      const { analytics } = await import('@/lib/analytics');

      // Act
      renderApp('/execution/task-123');

      // Assert
      await waitFor(() => {
        expect(analytics.trackPageView).toHaveBeenCalledWith('/execution/task-123');
      });
    });
  });

  describe('accessibility', () => {
    it('should have main landmark element', async () => {
      // Arrange & Act
      renderApp();

      // Assert
      await waitFor(() => {
        const main = screen.getByRole('main');
        expect(main).toBeInTheDocument();
      });
    });
  });
});
