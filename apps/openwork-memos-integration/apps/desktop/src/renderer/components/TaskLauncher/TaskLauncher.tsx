'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search, Plus, X } from 'lucide-react';
import { useTaskStore } from '@/stores/taskStore';
import { getAccomplish } from '@/lib/accomplish';
import { cn } from '@/lib/utils';
import { springs } from '@/lib/animations';
import TaskLauncherItem from './TaskLauncherItem';
import { hasAnyReadyProvider } from '@accomplish/shared';

export default function TaskLauncher() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const {
    isLauncherOpen,
    closeLauncher,
    tasks,
    startTask
  } = useTaskStore();
  const accomplish = getAccomplish();

  // Filter tasks by search query (title only)
  const filteredTasks = useMemo(() => {
    if (!searchQuery.trim()) {
      // Show last 7 days when no search
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return tasks.filter(t => new Date(t.createdAt).getTime() > sevenDaysAgo);
    }
    const query = searchQuery.toLowerCase();
    return tasks.filter(t => t.prompt.toLowerCase().includes(query));
  }, [tasks, searchQuery]);

  // Total items: "New task" + filtered tasks
  const totalItems = 1 + filteredTasks.length;

  // Reset state when modal opens
  useEffect(() => {
    if (isLauncherOpen) {
      setSearchQuery('');
      setSelectedIndex(0);
      // Focus input after animation
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isLauncherOpen]);

  // Clamp selected index when results change
  useEffect(() => {
    setSelectedIndex(i => Math.min(i, Math.max(0, totalItems - 1)));
  }, [totalItems]);

  const handleSelect = useCallback(async (index: number) => {
    if (index === 0) {
      // "New task" selected
      if (searchQuery.trim()) {
        // Check if any provider is ready before starting task
        const settings = await accomplish.getProviderSettings();
        if (!hasAnyReadyProvider(settings)) {
          // No ready provider - navigate to home which will show settings
          closeLauncher();
          navigate('/');
          return;
        }
        closeLauncher();
        const taskId = `task_${Date.now()}`;
        const task = await startTask({ prompt: searchQuery.trim(), taskId });
        if (task) {
          navigate(`/execution/${task.id}`);
        }
      } else {
        // Navigate to home for empty input
        closeLauncher();
        navigate('/');
      }
    } else {
      // Task selected - navigate to it
      const task = filteredTasks[index - 1];
      if (task) {
        closeLauncher();
        navigate(`/execution/${task.id}`);
      }
    }
  }, [searchQuery, filteredTasks, closeLauncher, navigate, startTask, accomplish]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, totalItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        handleSelect(selectedIndex);
        break;
      case 'Escape':
        e.preventDefault();
        closeLauncher();
        break;
    }
  }, [totalItems, selectedIndex, handleSelect, closeLauncher]);

  return (
    <DialogPrimitive.Root open={isLauncherOpen} onOpenChange={(open) => !open && closeLauncher()}>
      <AnimatePresence>
        {isLauncherOpen && (
          <DialogPrimitive.Portal forceMount>
            {/* Overlay */}
            <DialogPrimitive.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
              />
            </DialogPrimitive.Overlay>

            {/* Content */}
            <DialogPrimitive.Content
              className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
              onKeyDown={handleKeyDown}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: -10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -10 }}
                transition={springs.bouncy}
                className="w-full max-w-lg bg-card border border-border rounded-lg shadow-2xl overflow-hidden"
              >
                {/* Search Input */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                  <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                  <input
                    ref={inputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search tasks..."
                    className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  <DialogPrimitive.Close asChild>
                    <button className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
                      <X className="h-4 w-4" />
                    </button>
                  </DialogPrimitive.Close>
                </div>

                {/* Results */}
                <div className="max-h-80 overflow-y-auto p-2">
                  {/* New Task Option */}
                  <button
                    onClick={() => handleSelect(0)}
                    className={cn(
                      'w-full text-left px-3 py-2 rounded-md text-sm transition-colors duration-100',
                      'flex items-center gap-2',
                      selectedIndex === 0
                        ? 'bg-primary text-primary-foreground'
                        : 'text-foreground hover:bg-accent'
                    )}
                  >
                    <Plus className="h-4 w-4 shrink-0" />
                    <span>New task</span>
                    {searchQuery.trim() && (
                      <span className={cn(
                        'text-xs truncate',
                        selectedIndex === 0 ? 'text-primary-foreground/70' : 'text-muted-foreground'
                      )}>
                        — "{searchQuery}"
                      </span>
                    )}
                  </button>

                  {/* Task List */}
                  {filteredTasks.length > 0 && (
                    <>
                      <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
                        {searchQuery.trim() ? 'Results' : 'Last 7 days'}
                      </div>
                      {filteredTasks.slice(0, 10).map((task, i) => (
                        <TaskLauncherItem
                          key={task.id}
                          task={task}
                          isSelected={selectedIndex === i + 1}
                          onClick={() => handleSelect(i + 1)}
                        />
                      ))}
                    </>
                  )}

                  {/* Empty State */}
                  {searchQuery.trim() && filteredTasks.length === 0 && (
                    <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                      No tasks found
                    </div>
                  )}
                </div>

                {/* Footer hint */}
                <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground flex items-center gap-4">
                  <span><kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px]">↑↓</kbd> Navigate</span>
                  <span><kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px]">↵</kbd> Select</span>
                  <span><kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px]">Esc</kbd> Close</span>
                </div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
