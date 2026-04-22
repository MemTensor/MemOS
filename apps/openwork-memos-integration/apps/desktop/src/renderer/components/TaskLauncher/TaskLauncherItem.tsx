'use client';

import type { Task } from '@accomplish/shared';
import { cn } from '@/lib/utils';
import { Loader2, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';

interface TaskLauncherItemProps {
  task: Task;
  isSelected: boolean;
  onClick: () => void;
}

function formatRelativeDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getStatusIcon(status: Task['status']) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />;
    case 'completed':
      return <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />;
    case 'failed':
      return <XCircle className="h-3 w-3 text-destructive shrink-0" />;
    case 'cancelled':
    case 'interrupted':
      return <AlertCircle className="h-3 w-3 text-yellow-500 shrink-0" />;
    default:
      return null;
  }
}

export default function TaskLauncherItem({ task, isSelected, onClick }: TaskLauncherItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2 rounded-md text-sm transition-colors duration-100',
        'flex items-center gap-2',
        isSelected
          ? 'bg-primary text-primary-foreground'
          : 'text-foreground hover:bg-accent'
      )}
    >
      {getStatusIcon(task.status)}
      <span className="truncate flex-1">{task.prompt}</span>
      <span className={cn(
        'text-xs shrink-0',
        isSelected ? 'text-primary-foreground/70' : 'text-muted-foreground'
      )}>
        {formatRelativeDate(task.createdAt)}
      </span>
    </button>
  );
}
