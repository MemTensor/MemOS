'use client';

import { useEffect, useState, useRef, useMemo, useCallback, memo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTaskStore } from '../stores/taskStore';
import { getAccomplish } from '../lib/accomplish';
import { springs } from '../lib/animations';
import type { TaskMessage } from '@accomplish/shared';
import { hasAnyReadyProvider } from '@accomplish/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { XCircle, CornerDownLeft, ArrowLeft, CheckCircle2, AlertCircle, AlertTriangle, Terminal, Wrench, FileText, Search, Code, Brain, Clock, Square, Play, Download, File, Bug, ChevronUp, ChevronDown, Trash2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import { StreamingText } from '../components/ui/streaming-text';
import { isWaitingForUser } from '../lib/waiting-detection';
import loadingSymbol from '/assets/loading-symbol.svg';
import SettingsDialog from '../components/layout/SettingsDialog';

// Debug log entry type
interface DebugLogEntry {
  taskId: string;
  timestamp: string;
  type: string;
  message: string;
  data?: unknown;
}

// Spinning Openwork icon component
const SpinningIcon = ({ className }: { className?: string }) => (
  <img
    src={loadingSymbol}
    alt=""
    className={cn('animate-spin-ccw', className)}
  />
);

// Tool name to human-readable progress mapping
const TOOL_PROGRESS_MAP: Record<string, { label: string; icon: typeof FileText }> = {
  // Standard Claude Code tools
  Read: { label: 'Reading files', icon: FileText },
  Glob: { label: 'Finding files', icon: Search },
  Grep: { label: 'Searching code', icon: Search },
  Bash: { label: 'Running command', icon: Terminal },
  Write: { label: 'Writing file', icon: FileText },
  Edit: { label: 'Editing file', icon: FileText },
  Task: { label: 'Running agent', icon: Brain },
  WebFetch: { label: 'Fetching web page', icon: Search },
  WebSearch: { label: 'Searching web', icon: Search },
  // Dev Browser tools
  dev_browser_execute: { label: 'Executing browser action', icon: Terminal },
};

// Debounce utility
function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timeoutId: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), ms);
  }) as T;
}

// Helper for file operation badge colors
function getOperationBadgeClasses(operation?: string): string {
  switch (operation) {
    case 'delete': return 'bg-red-500/10 text-red-600';
    case 'overwrite': return 'bg-orange-500/10 text-orange-600';
    case 'modify': return 'bg-yellow-500/10 text-yellow-600';
    case 'create': return 'bg-green-500/10 text-green-600';
    case 'rename':
    case 'move': return 'bg-blue-500/10 text-blue-600';
    default: return 'bg-gray-500/10 text-gray-600';
  }
}

// Helper to check if this is a delete operation
function isDeleteOperation(request: { type: string; fileOperation?: string }): boolean {
  return request.type === 'file' && request.fileOperation === 'delete';
}

// Get file paths to display (handles both single and multiple)
function getDisplayFilePaths(request: { filePath?: string; filePaths?: string[] }): string[] {
  if (request.filePaths && request.filePaths.length > 0) {
    return request.filePaths;
  }
  if (request.filePath) {
    return [request.filePath];
  }
  return [];
}

export default function ExecutionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const accomplish = getAccomplish();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [followUp, setFollowUp] = useState('');
  const followUpInputRef = useRef<HTMLInputElement>(null);
  const [taskRunCount, setTaskRunCount] = useState(0);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [currentToolInput, setCurrentToolInput] = useState<unknown>(null);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [debugModeEnabled, setDebugModeEnabled] = useState(false);
  const [debugExported, setDebugExported] = useState(false);
  const debugPanelRef = useRef<HTMLDivElement>(null);
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [customResponse, setCustomResponse] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [pendingFollowUp, setPendingFollowUp] = useState<string | null>(null);

  const {
    currentTask,
    loadTaskById,
    isLoading,
    error,
    addTaskUpdate,
    addTaskUpdateBatch,
    updateTaskStatus,
    setPermissionRequest,
    permissionRequest,
    respondToPermission,
    sendFollowUp,
    interruptTask,
    setupProgress,
    setupProgressTaskId,
    setupDownloadStep,
  } = useTaskStore();

  // Debounced scroll function
  const scrollToBottom = useMemo(
    () =>
      debounce(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100),
    []
  );

  // Load debug mode setting on mount and subscribe to changes
  useEffect(() => {
    accomplish.getDebugMode().then(setDebugModeEnabled);

    // Subscribe to debug mode changes from settings
    const unsubscribeDebugMode = accomplish.onDebugModeChange?.(({ enabled }) => {
      setDebugModeEnabled(enabled);
    });

    return () => {
      unsubscribeDebugMode?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - accomplish is a stable singleton wrapper

  // Load task and subscribe to events
  useEffect(() => {
    if (id) {
      loadTaskById(id);
      // Clear debug logs when switching tasks
      setDebugLogs([]);
    }

    // Handle individual task updates
    const unsubscribeTask = accomplish.onTaskUpdate((event) => {
      addTaskUpdate(event);
      // Track current tool from tool messages
      if (event.type === 'message' && event.message?.type === 'tool') {
        const toolName = event.message.toolName || event.message.content?.match(/Using tool: (\w+)/)?.[1];
        if (toolName) {
          setCurrentTool(toolName);
          setCurrentToolInput(event.message.toolInput);
        }
      }
      // Clear tool on completion
      if (event.type === 'complete' || event.type === 'error') {
        setCurrentTool(null);
        setCurrentToolInput(null);
      }
    });

    // Handle batched task updates (for performance)
    const unsubscribeTaskBatch = accomplish.onTaskUpdateBatch?.((event) => {
      if (event.messages?.length) {
        addTaskUpdateBatch(event);
        // Track current tool from the last tool message
        const lastToolMsg = [...event.messages].reverse().find(m => m.type === 'tool');
        if (lastToolMsg) {
          const toolName = lastToolMsg.toolName || lastToolMsg.content?.match(/Using tool: (\w+)/)?.[1];
          if (toolName) {
            setCurrentTool(toolName);
            setCurrentToolInput(lastToolMsg.toolInput);
          }
        }
      }
    });

    const unsubscribePermission = accomplish.onPermissionRequest((request) => {
      setPermissionRequest(request);
    });

    // Subscribe to task status changes (e.g., queued -> running)
    const unsubscribeStatusChange = accomplish.onTaskStatusChange?.((data) => {
      if (data.taskId === id) {
        updateTaskStatus(data.taskId, data.status);
      }
    });

    // Subscribe to debug logs
    const unsubscribeDebugLog = accomplish.onDebugLog((log) => {
      const entry = log as DebugLogEntry;
      if (entry.taskId === id) {
        setDebugLogs((prev) => [...prev, entry]);
      }
    });

    return () => {
      unsubscribeTask();
      unsubscribeTaskBatch?.();
      unsubscribePermission();
      unsubscribeStatusChange?.();
      unsubscribeDebugLog();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loadTaskById, addTaskUpdate, addTaskUpdateBatch, updateTaskStatus, setPermissionRequest]); // accomplish is stable singleton

  // Increment counter when task starts/resumes
  useEffect(() => {
    if (currentTask?.status === 'running') {
      setTaskRunCount((c) => c + 1);
    }
  }, [currentTask?.status]);

  // Auto-scroll to bottom (debounced for performance)
  useEffect(() => {
    scrollToBottom();
  }, [currentTask?.messages?.length, scrollToBottom]);

  // Auto-scroll debug panel when new logs arrive
  useEffect(() => {
    if (debugPanelOpen && debugPanelRef.current) {
      debugPanelRef.current.scrollTop = debugPanelRef.current.scrollHeight;
    }
  }, [debugLogs.length, debugPanelOpen]);

  // Auto-focus follow-up input when task completes
  const isComplete = ['completed', 'failed', 'cancelled', 'interrupted'].includes(currentTask?.status ?? '');
  const hasSession = currentTask?.sessionId || currentTask?.result?.sessionId;
  const canFollowUp = isComplete && (hasSession || currentTask?.status === 'interrupted');

  useEffect(() => {
    if (canFollowUp) {
      followUpInputRef.current?.focus();
    }
  }, [canFollowUp]);

  const handleFollowUp = async () => {
    if (!followUp.trim()) return;

    // Check if any provider is ready before sending (skip in E2E mode)
    const isE2EMode = await accomplish.isE2EMode();
    if (!isE2EMode) {
      const settings = await accomplish.getProviderSettings();
      if (!hasAnyReadyProvider(settings)) {
        // Store the pending message and open settings dialog
        setPendingFollowUp(followUp);
        setShowSettingsDialog(true);
        return;
      }
    }

    await sendFollowUp(followUp);
    setFollowUp('');
  };

  const handleSettingsDialogClose = (open: boolean) => {
    setShowSettingsDialog(open);
    if (!open) {
      setPendingFollowUp(null);
    }
  };

  const handleApiKeySaved = async () => {
    // Provider is now ready - close dialog and send the pending message
    setShowSettingsDialog(false);
    if (pendingFollowUp) {
      await sendFollowUp(pendingFollowUp);
      setFollowUp('');
      setPendingFollowUp(null);
    }
  };

  const handleContinue = async () => {
    // Check if any provider is ready before sending (skip in E2E mode)
    const isE2EMode = await accomplish.isE2EMode();
    if (!isE2EMode) {
      const settings = await accomplish.getProviderSettings();
      if (!hasAnyReadyProvider(settings)) {
        // Store the pending message and open settings dialog
        setPendingFollowUp('continue');
        setShowSettingsDialog(true);
        return;
      }
    }

    // Send a simple "continue" message to resume the task
    await sendFollowUp('continue');
  };

  const handleExportDebugLogs = useCallback(() => {
    const text = debugLogs
      .map((log) => {
        const dataStr = log.data !== undefined
          ? ` ${typeof log.data === 'string' ? log.data : JSON.stringify(log.data)}`
          : '';
        return `${new Date(log.timestamp).toISOString()} [${log.type}] ${log.message}${dataStr}`;
      })
      .join('\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `debug-logs-${id}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setDebugExported(true);
    setTimeout(() => setDebugExported(false), 2000);
  }, [debugLogs, id]);

  const handlePermissionResponse = async (allowed: boolean) => {
    if (!permissionRequest || !currentTask) return;

    // For questions, handle custom text response
    const isQuestion = permissionRequest.type === 'question';
    const hasCustomText = isQuestion && showCustomInput && customResponse.trim();

    await respondToPermission({
      requestId: permissionRequest.id,
      taskId: permissionRequest.taskId,
      decision: allowed ? 'allow' : 'deny',
      selectedOptions: isQuestion ? (hasCustomText ? [] : selectedOptions) : undefined,
      customText: hasCustomText ? customResponse.trim() : undefined,
    });

    // Reset state for next question
    setSelectedOptions([]);
    setCustomResponse('');
    setShowCustomInput(false);

    // If denied on a question, also interrupt the task
    if (!allowed && isQuestion) {
      interruptTask();
    }
  };

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <Card className="max-w-md w-full p-6 text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <p className="text-destructive mb-4">{error}</p>
          <Button onClick={() => navigate('/')}>Go Home</Button>
        </Card>
      </div>
    );
  }

  if (!currentTask) {
    return (
      <div className="h-full flex items-center justify-center">
        <SpinningIcon className="h-8 w-8" />
      </div>
    );
  }

  const getStatusBadge = () => {
    switch (currentTask.status) {
      case 'queued':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600 shrink-0">
            <Clock className="h-3 w-3" />
            Queued
          </span>
        );
      case 'running':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-primary/10 shrink-0">
            <span
              className="animate-shimmer bg-gradient-to-r from-primary via-primary/50 to-primary bg-[length:200%_100%] bg-clip-text text-transparent"
            >
              Running
            </span>
          </span>
        );
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-600 shrink-0">
            <CheckCircle2 className="h-3 w-3" />
            Completed
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-destructive/10 text-destructive shrink-0">
            <XCircle className="h-3 w-3" />
            Failed
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground shrink-0">
            <XCircle className="h-3 w-3" />
            Cancelled
          </span>
        );
      case 'interrupted':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600 shrink-0">
            <Square className="h-3 w-3" />
            Stopped
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground shrink-0">
            {currentTask.status}
          </span>
        );
    }
  };

  return (
    <>
      {/* Settings Dialog - shown when no provider is ready */}
      <SettingsDialog
        open={showSettingsDialog}
        onOpenChange={handleSettingsDialogClose}
        onApiKeySaved={handleApiKeySaved}
      />

    <div className="h-full flex flex-col bg-background relative">
      {/* Task header */}
      <div className="flex-shrink-0 border-b border-border bg-card/50 px-6 py-4">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/')}
              className="shrink-0 no-drag"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <h1 className="text-base font-medium text-foreground truncate min-w-0">
                {currentTask.prompt}
              </h1>
              <span data-testid="execution-status-badge">
                {getStatusBadge()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Browser installation modal - only shown during Playwright download */}
      <AnimatePresence>
        {setupProgress && setupProgressTaskId === id && (setupProgress.toLowerCase().includes('download') || setupProgress.includes('% of')) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={springs.bouncy}
            >
              <Card className="w-[480px] p-6">
                <div className="flex flex-col items-center text-center gap-4">
                  <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                    <Download className="h-7 w-7 text-primary" />
                    <motion.div
                      className="absolute inset-0 rounded-full border-2 border-primary/30 border-t-primary"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    />
                  </div>
                  <div className="w-full">
                    <h3 className="text-lg font-semibold text-foreground mb-1">
                      Chrome not installed
                    </h3>
                    <p className="text-muted-foreground mb-4">
                      Installing browser for automation...
                    </p>
                    {/* Progress bar - combines all downloads into single 0-100% */}
                    {(() => {
                      const percentMatch = setupProgress?.match(/(\d+)%/);
                      const currentPercent = percentMatch ? parseInt(percentMatch[1], 10) : 0;

                      // Weight each download by size: Chromium ~160MB (64%), FFMPEG ~1MB (0%), Headless ~90MB (36%)
                      // Step 1: 0-64%, Step 2: 64-64%, Step 3: 64-100%
                      let overallPercent = 0;
                      if (setupDownloadStep === 1) {
                        overallPercent = Math.round(currentPercent * 0.64);
                      } else if (setupDownloadStep === 2) {
                        overallPercent = 64 + Math.round(currentPercent * 0.01);
                      } else {
                        overallPercent = 65 + Math.round(currentPercent * 0.35);
                      }

                      return (
                        <div className="w-full">
                          <div className="flex justify-between text-sm mb-2">
                            <span className="text-muted-foreground">Downloading...</span>
                            <span className="text-foreground font-medium">{overallPercent}%</span>
                          </div>
                          <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                            <motion.div
                              className="h-full bg-primary rounded-full"
                              initial={{ width: 0 }}
                              animate={{ width: `${overallPercent}%` }}
                              transition={{ duration: 0.3 }}
                            />
                          </div>
                        </div>
                      );
                    })()}
                    <p className="text-xs text-muted-foreground mt-4 text-center">
                      One-time setup (~250 MB total)
                    </p>
                  </div>
                </div>
              </Card>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Queued state - full page (new task, no messages yet) */}
      {currentTask.status === 'queued' && currentTask.messages.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={springs.gentle}
          className="flex-1 flex flex-col items-center justify-center gap-6 px-6"
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10">
            <Clock className="h-8 w-8 text-amber-600" />
          </div>
          <div className="text-center max-w-md">
            <h2 className="text-xl font-semibold text-foreground mb-2">
              Waiting for another task
            </h2>
            <p className="text-muted-foreground">
              Your task is queued and will start automatically when the current task completes.
            </p>
          </div>
        </motion.div>
      )}

      {/* Queued state - inline (follow-up, has previous messages) */}
      {currentTask.status === 'queued' && currentTask.messages.length > 0 && (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-4xl mx-auto space-y-4">
            {currentTask.messages
              .filter((m) => !(m.type === 'tool' && m.toolName?.toLowerCase() === 'bash'))
              .map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}

            {/* Inline waiting indicator */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={springs.gentle}
              className="flex flex-col items-center gap-4 py-8"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
                <Clock className="h-6 w-6 text-amber-600" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">
                  Waiting for another task
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Your follow-up will continue automatically
                </p>
              </div>
            </motion.div>

            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* Messages - normal state (running, completed, failed, etc.) */}
      {currentTask.status !== 'queued' && (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-4xl mx-auto space-y-4">
            {currentTask.messages
              .filter((m) => !(m.type === 'tool' && m.toolName?.toLowerCase() === 'bash'))
              .map((message, index, filteredMessages) => {
              const isLastMessage = index === filteredMessages.length - 1;
              const isLastAssistantMessage =
                message.type === 'assistant' && isLastMessage;
              // Find the last assistant message index for the continue button
              let lastAssistantIndex = -1;
              for (let i = filteredMessages.length - 1; i >= 0; i--) {
                if (filteredMessages[i].type === 'assistant') {
                  lastAssistantIndex = i;
                  break;
                }
              }
              const isLastAssistantForContinue = index === lastAssistantIndex;
              // Show continue button on last assistant message when:
              // - Task was interrupted (user can always continue)
              // - Task completed AND the message indicates agent is waiting for user action
              const showContinue = isLastAssistantForContinue && !!hasSession &&
                (currentTask.status === 'interrupted' ||
                 (currentTask.status === 'completed' && isWaitingForUser(message.content)));
              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  shouldStream={isLastAssistantMessage && currentTask.status === 'running'}
                  isLastMessage={isLastMessage}
                  isRunning={currentTask.status === 'running'}
                  showContinueButton={showContinue}
                  continueLabel={currentTask.status === 'interrupted' ? 'Continue' : 'Done, Continue'}
                  onContinue={handleContinue}
                  isLoading={isLoading}
                />
              );
            })}

            <AnimatePresence>
              {currentTask.status === 'running' && !permissionRequest && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={springs.gentle}
                  className="flex items-center gap-2 text-muted-foreground py-2"
                  data-testid="execution-thinking-indicator"
                >
                  <SpinningIcon className="h-4 w-4" />
                  <span className="text-sm">
                    {currentTool
                      ? ((currentToolInput as { description?: string })?.description || TOOL_PROGRESS_MAP[currentTool]?.label || currentTool)
                      : 'Thinking...'}
                  </span>
                  {currentTool && !(currentToolInput as { description?: string })?.description && (
                    <span className="text-xs text-muted-foreground/60">
                      ({currentTool})
                    </span>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* Permission Request Modal */}
      <AnimatePresence>
        {permissionRequest && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            data-testid="execution-permission-modal"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={springs.bouncy}
            >
              <Card className="w-full max-w-lg p-6 mx-4">
                <div className="flex items-start gap-4">
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full shrink-0",
                    isDeleteOperation(permissionRequest) ? "bg-red-500/10" :
                    permissionRequest.type === 'file' ? "bg-amber-500/10" :
                    permissionRequest.type === 'question' ? "bg-primary/10" : "bg-warning/10"
                  )}>
                    {isDeleteOperation(permissionRequest) ? (
                      <AlertTriangle className="h-5 w-5 text-red-600" />
                    ) : permissionRequest.type === 'file' ? (
                      <File className="h-5 w-5 text-amber-600" />
                    ) : permissionRequest.type === 'question' ? (
                      <Brain className="h-5 w-5 text-primary" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-warning" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className={cn(
                      "text-lg font-semibold mb-2",
                      isDeleteOperation(permissionRequest) ? "text-red-600" : "text-foreground"
                    )}>
                      {isDeleteOperation(permissionRequest)
                        ? 'File Deletion Warning'
                        : permissionRequest.type === 'file'
                          ? 'File Permission Required'
                          : permissionRequest.type === 'question'
                            ? (permissionRequest.header || 'Question')
                            : 'Permission Required'}
                    </h3>

                    {/* File permission specific UI */}
                    {permissionRequest.type === 'file' && (
                      <>
                        {/* Delete operation warning banner */}
                        {isDeleteOperation(permissionRequest) && (
                          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                            <p className="text-sm text-red-600">
                              {(() => {
                                const paths = getDisplayFilePaths(permissionRequest);
                                return paths.length > 1
                                  ? `${paths.length} files will be permanently deleted:`
                                  : 'This file will be permanently deleted:';
                              })()}
                            </p>
                          </div>
                        )}

                        {/* Non-delete operation badge */}
                        {!isDeleteOperation(permissionRequest) && (
                          <div className="mb-3">
                            <span className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
                              getOperationBadgeClasses(permissionRequest.fileOperation)
                            )}>
                              {permissionRequest.fileOperation?.toUpperCase()}
                            </span>
                          </div>
                        )}

                        {/* File path(s) display */}
                        <div className={cn(
                          "mb-4 p-3 rounded-lg",
                          isDeleteOperation(permissionRequest)
                            ? "bg-red-500/5 border border-red-500/20"
                            : "bg-muted"
                        )}>
                          {(() => {
                            const paths = getDisplayFilePaths(permissionRequest);
                            if (paths.length > 1) {
                              return (
                                <ul className="space-y-1">
                                  {paths.map((path, idx) => (
                                    <li key={idx} className={cn(
                                      "text-sm font-mono break-all",
                                      isDeleteOperation(permissionRequest) ? "text-red-600" : "text-foreground"
                                    )}>
                                      • {path}
                                    </li>
                                  ))}
                                </ul>
                              );
                            }
                            return (
                              <p className={cn(
                                "text-sm font-mono break-all",
                                isDeleteOperation(permissionRequest) ? "text-red-600" : "text-foreground"
                              )}>
                                {paths[0]}
                              </p>
                            );
                          })()}
                          {permissionRequest.targetPath && (
                            <p className="text-sm font-mono text-muted-foreground mt-1">
                              → {permissionRequest.targetPath}
                            </p>
                          )}
                        </div>

                        {/* Delete warning text */}
                        {isDeleteOperation(permissionRequest) && (
                          <p className="text-sm text-red-600/80 mb-4">
                            This action cannot be undone.
                          </p>
                        )}

                        {permissionRequest.contentPreview && (
                          <details className="mb-4">
                            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                              Preview content
                            </summary>
                            <pre className="mt-2 p-2 rounded bg-muted text-xs overflow-x-auto max-h-32 overflow-y-auto">
                              {permissionRequest.contentPreview}
                            </pre>
                          </details>
                        )}
                      </>
                    )}

                    {/* Question type UI with options */}
                    {permissionRequest.type === 'question' && (
                      <>
                        <p className="text-sm text-foreground mb-4">
                          {permissionRequest.question}
                        </p>

                        {/* Options list */}
                        {!showCustomInput && permissionRequest.options && permissionRequest.options.length > 0 && (
                          <div className="mb-4 space-y-2">
                            {permissionRequest.options.map((option, idx) => (
                              <button
                                key={idx}
                                onClick={() => {
                                  // If "Other" is selected, show custom input
                                  if (option.label.toLowerCase() === 'other') {
                                    setShowCustomInput(true);
                                    setSelectedOptions([]);
                                    return;
                                  }
                                  if (permissionRequest.multiSelect) {
                                    setSelectedOptions((prev) =>
                                      prev.includes(option.label)
                                        ? prev.filter((o) => o !== option.label)
                                        : [...prev, option.label]
                                    );
                                  } else {
                                    setSelectedOptions([option.label]);
                                  }
                                }}
                                className={cn(
                                  "w-full text-left p-3 rounded-lg border transition-colors",
                                  selectedOptions.includes(option.label)
                                    ? "border-primary bg-primary/10"
                                    : "border-border hover:border-primary/50"
                                )}
                              >
                                <div className="font-medium text-sm">{option.label}</div>
                                {option.description && (
                                  <div className="text-xs text-muted-foreground mt-1">
                                    {option.description}
                                  </div>
                                )}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Custom text input */}
                        {showCustomInput && (
                          <div className="mb-4 space-y-2">
                            <Input
                              autoFocus
                              value={customResponse}
                              onChange={(e) => setCustomResponse(e.target.value)}
                              placeholder="Type your response..."
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && customResponse.trim()) {
                                  handlePermissionResponse(true);
                                }
                              }}
                            />
                            <button
                              onClick={() => {
                                setShowCustomInput(false);
                                setCustomResponse('');
                              }}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              ← Back to options
                            </button>
                          </div>
                        )}
                      </>
                    )}

                    {/* Standard tool UI (non-file, non-question) */}
                    {permissionRequest.type === 'tool' && (
                      <>
                        <p className="text-sm text-muted-foreground mb-4">
                          Allow {permissionRequest.toolName}?
                        </p>
                        {permissionRequest.toolName && (
                          <div className="mb-4 p-3 rounded-lg bg-muted text-xs font-mono overflow-x-auto">
                            <p className="text-muted-foreground mb-1">Tool: {permissionRequest.toolName}</p>
                            <pre className="text-foreground">
                              {JSON.stringify(permissionRequest.toolInput, null, 2)}
                            </pre>
                          </div>
                        )}
                      </>
                    )}

                    <div className="flex gap-3">
                      <Button
                        variant="outline"
                        onClick={() => handlePermissionResponse(false)}
                        className="flex-1"
                        data-testid="permission-deny-button"
                      >
                        {permissionRequest.type === 'question' ? 'Cancel' : 'Deny'}
                      </Button>
                      <Button
                        onClick={() => handlePermissionResponse(true)}
                        className={cn(
                          "flex-1",
                          isDeleteOperation(permissionRequest) && "bg-red-600 hover:bg-red-700 text-white"
                        )}
                        data-testid="permission-allow-button"
                        disabled={
                          permissionRequest.type === 'question' &&
                          !showCustomInput &&
                          permissionRequest.options &&
                          selectedOptions.length === 0
                        }
                      >
                        {isDeleteOperation(permissionRequest)
                          ? getDisplayFilePaths(permissionRequest).length > 1
                            ? 'Delete All'
                            : 'Delete'
                          : permissionRequest.type === 'question'
                            ? 'Submit'
                            : 'Allow'}
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

{/* Running state input with Stop button */}
      {currentTask.status === 'running' && !permissionRequest && (
        <div className="flex-shrink-0 border-t border-border bg-card/50 px-6 py-4">
          <div className="max-w-4xl mx-auto flex gap-3">
            <Input
              placeholder="Agent is working..."
              disabled
              className="flex-1 opacity-50"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={interruptTask}
              title="Stop agent (Ctrl+C)"
              className="shrink-0 hover:bg-destructive/10 hover:text-destructive hover:border-destructive"
              data-testid="execution-stop-button"
            >
              <Square className="h-4 w-4 fill-current" />
            </Button>
          </div>
        </div>
      )}

      {/* Follow-up input */}
      {canFollowUp && (
        <div className="flex-shrink-0 border-t border-border bg-card/50 px-6 py-4">
          <div className="max-w-4xl mx-auto">
            {/* Input field with Send button */}
            <div className="flex gap-3">
              <Input
                ref={followUpInputRef}
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleFollowUp();
                  }
                }}
                placeholder={
                  currentTask.status === 'interrupted'
                    ? (hasSession ? "Give new instructions..." : "Send a new instruction to retry...")
                    : currentTask.status === 'completed'
                      ? "Give new instructions..."
                      : "Ask for something..."
                }
                disabled={isLoading}
                className="flex-1"
                data-testid="execution-follow-up-input"
              />
              <Button
                onClick={handleFollowUp}
                disabled={!followUp.trim() || isLoading}
                variant="outline"
              >
                <CornerDownLeft className="h-4 w-4 mr-1.5" />
                Send
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Completed/Failed state (no session to continue) */}
      {isComplete && !canFollowUp && (
        <div className="flex-shrink-0 border-t border-border bg-card/50 px-6 py-4 text-center">
          <p className="text-sm text-muted-foreground mb-3">
            Task {currentTask.status === 'interrupted' ? 'stopped' : currentTask.status}
          </p>
          <Button onClick={() => navigate('/')}>
            Start New Task
          </Button>
        </div>
      )}

      {/* Debug Panel - Only visible when debug mode is enabled */}
      {debugModeEnabled && (
        <div className="flex-shrink-0 border-t border-border" data-testid="debug-panel">
          {/* Toggle header */}
          <button
            onClick={() => setDebugPanelOpen(!debugPanelOpen)}
            className="w-full flex items-center justify-between px-6 py-2.5 bg-zinc-900 hover:bg-zinc-800 transition-colors"
          >
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Bug className="h-4 w-4" />
              <span className="font-medium">Debug Logs</span>
              {debugLogs.length > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-zinc-700 text-zinc-300 text-xs">
                  {debugLogs.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {debugLogs.length > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExportDebugLogs();
                    }}
                  >
                    {debugExported ? (
                      <Check className="h-3 w-3 mr-1 text-green-400" />
                    ) : (
                      <Download className="h-3 w-3 mr-1" />
                    )}
                    {debugExported ? 'Exported' : 'Export'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDebugLogs([]);
                    }}
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    Clear
                  </Button>
                </>
              )}
              {debugPanelOpen ? (
                <ChevronDown className="h-4 w-4 text-zinc-500" />
              ) : (
                <ChevronUp className="h-4 w-4 text-zinc-500" />
              )}
            </div>
          </button>

          {/* Collapsible panel content */}
          <AnimatePresence>
            {debugPanelOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 200, opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div
                  ref={debugPanelRef}
                  className="h-[200px] overflow-y-auto bg-zinc-950 text-zinc-300 font-mono text-xs p-4"
                >
                  {debugLogs.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-zinc-500">
                      No debug logs yet. Run a task to see logs.
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {debugLogs.map((log, index) => (
                        <div key={index} className="flex gap-2">
                          <span className="text-zinc-500 shrink-0">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                          <span className={cn(
                            'shrink-0 px-1 rounded',
                            log.type === 'error' ? 'bg-red-500/20 text-red-400' :
                            log.type === 'warn' ? 'bg-yellow-500/20 text-yellow-400' :
                            log.type === 'info' ? 'bg-blue-500/20 text-blue-400' :
                            'bg-zinc-700 text-zinc-400'
                          )}>
                            [{log.type}]
                          </span>
                          <span className="text-zinc-300 break-all">
                            {log.message}
                            {log.data !== undefined && (
                              <span className="text-zinc-500 ml-2">
                                {typeof log.data === 'string' ? log.data : JSON.stringify(log.data, null, 0)}
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
    </>
  );
}

interface MessageBubbleProps {
  message: TaskMessage;
  shouldStream?: boolean;
  isLastMessage?: boolean;
  isRunning?: boolean;
  showContinueButton?: boolean;
  continueLabel?: string;
  onContinue?: () => void;
  isLoading?: boolean;
}

// Memoized MessageBubble to prevent unnecessary re-renders and markdown re-parsing
const MessageBubble = memo(function MessageBubble({ message, shouldStream = false, isLastMessage = false, isRunning = false, showContinueButton = false, continueLabel, onContinue, isLoading = false }: MessageBubbleProps) {
  const [streamComplete, setStreamComplete] = useState(!shouldStream);
  const isUser = message.type === 'user';
  const isTool = message.type === 'tool';
  const isSystem = message.type === 'system';
  const isAssistant = message.type === 'assistant';

  // Get tool icon from mapping
  const toolName = message.toolName || message.content?.match(/Using tool: (\w+)/)?.[1];
  const ToolIcon = toolName && TOOL_PROGRESS_MAP[toolName]?.icon;

  // Mark stream as complete when shouldStream becomes false
  useEffect(() => {
    if (!shouldStream) {
      setStreamComplete(true);
    }
  }, [shouldStream]);

  const proseClasses = cn(
    'text-sm prose prose-sm max-w-none',
    'prose-headings:text-foreground',
    'prose-p:text-foreground prose-p:my-2',
    'prose-strong:text-foreground prose-strong:font-semibold',
    'prose-em:text-foreground',
    'prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs',
    'prose-pre:bg-muted prose-pre:text-foreground prose-pre:p-3 prose-pre:rounded-lg',
    'prose-ul:text-foreground prose-ol:text-foreground',
    'prose-li:text-foreground prose-li:my-1',
    'prose-a:text-primary prose-a:underline',
    'prose-blockquote:text-muted-foreground prose-blockquote:border-l-4 prose-blockquote:border-border prose-blockquote:pl-4',
    'prose-hr:border-border'
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.gentle}
      className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
    >
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-3 transition-all duration-150',
          isUser
            ? 'bg-primary text-primary-foreground'
            : isTool
              ? 'bg-muted border border-border'
              : isSystem
                ? 'bg-muted/50 border border-border'
                : 'bg-card border border-border'
        )}
      >
        {/* Tool messages: show only label and loading animation */}
        {isTool ? (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground font-medium">
              {ToolIcon ? <ToolIcon className="h-4 w-4" /> : <Wrench className="h-4 w-4" />}
              <span>{TOOL_PROGRESS_MAP[toolName || '']?.label || toolName || 'Processing'}</span>
              {isLastMessage && isRunning && (
                <SpinningIcon className="h-3.5 w-3.5 ml-1" />
              )}
            </div>
          </>
        ) : (
          <>
            {isSystem && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5 font-medium">
                <Terminal className="h-3.5 w-3.5" />
                System
              </div>
            )}
            {isUser ? (
              <p
                className={cn(
                  'text-sm whitespace-pre-wrap break-words',
                  'text-primary-foreground'
                )}
              >
                {message.content}
              </p>
            ) : isAssistant && shouldStream && !streamComplete ? (
              <StreamingText
                text={message.content}
                speed={120}
                isComplete={streamComplete}
                onComplete={() => setStreamComplete(true)}
              >
                {(streamedText) => (
                  <div className={proseClasses}>
                    <ReactMarkdown>{streamedText}</ReactMarkdown>
                  </div>
                )}
              </StreamingText>
            ) : (
              <div className={proseClasses}>
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            )}
            <p
              className={cn(
                'text-xs mt-1.5',
                isUser ? 'text-primary-foreground/70' : 'text-muted-foreground'
              )}
            >
              {new Date(message.timestamp).toLocaleTimeString()}
            </p>
            {/* Continue button inside assistant bubble */}
            {isAssistant && showContinueButton && onContinue && (
              <Button
                size="sm"
                onClick={onContinue}
                disabled={isLoading}
                className="mt-3 gap-1.5"
              >
                <Play className="h-3 w-3" />
                {continueLabel || 'Continue'}
              </Button>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}, (prev, next) => prev.message.id === next.message.id && prev.shouldStream === next.shouldStream && prev.isLastMessage === next.isLastMessage && prev.isRunning === next.isRunning && prev.showContinueButton === next.showContinueButton && prev.isLoading === next.isLoading);
