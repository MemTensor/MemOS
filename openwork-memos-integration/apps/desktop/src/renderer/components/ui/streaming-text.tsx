/**
 * StreamingText - A component that reveals text character-by-character
 * for a more engaging, "typing" effect during AI responses.
 */

import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface StreamingTextProps {
  text: string;
  /** Characters per second reveal rate (default: 80) */
  speed?: number;
  /** Whether streaming is complete (shows full text immediately) */
  isComplete?: boolean;
  /** Callback when streaming finishes */
  onComplete?: () => void;
  /** Additional className for the container */
  className?: string;
  /** Render function for the displayed text */
  children: (displayedText: string) => React.ReactNode;
}

export function StreamingText({
  text,
  speed = 80,
  isComplete = false,
  onComplete,
  className,
  children,
}: StreamingTextProps) {
  const [displayedLength, setDisplayedLength] = useState(isComplete ? text.length : 0);
  const [isStreaming, setIsStreaming] = useState(!isComplete);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const textRef = useRef(text);

  // Update ref when text changes
  useEffect(() => {
    // If new text is longer, continue streaming from current position
    if (text.length > textRef.current.length && !isComplete) {
      setIsStreaming(true);
    }
    textRef.current = text;
  }, [text, isComplete]);

  // Handle immediate completion
  useEffect(() => {
    if (isComplete) {
      setDisplayedLength(text.length);
      setIsStreaming(false);
    }
  }, [isComplete, text.length]);

  // Animation loop
  useEffect(() => {
    if (!isStreaming || isComplete) return;

    const charsPerMs = speed / 1000;

    const animate = (timestamp: number) => {
      if (!lastTimeRef.current) {
        lastTimeRef.current = timestamp;
      }

      const elapsed = timestamp - lastTimeRef.current;
      const charsToAdd = Math.floor(elapsed * charsPerMs);

      if (charsToAdd > 0) {
        setDisplayedLength((prev) => {
          const next = Math.min(prev + charsToAdd, textRef.current.length);
          if (next >= textRef.current.length) {
            setIsStreaming(false);
            onComplete?.();
          }
          return next;
        });
        lastTimeRef.current = timestamp;
      }

      if (displayedLength < textRef.current.length) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [isStreaming, isComplete, speed, onComplete, displayedLength]);

  const displayedText = text.slice(0, displayedLength);

  return (
    <div className={className}>
      {children(displayedText)}
      {isStreaming && displayedLength < text.length && (
        <span className="inline-block w-2 h-4 bg-foreground/60 animate-pulse ml-0.5 align-text-bottom" />
      )}
    </div>
  );
}

/**
 * Hook to track whether a message should be streamed
 * (only the latest assistant message while task is running)
 */
export function useStreamingState(
  messageId: string,
  isLatestAssistantMessage: boolean,
  isTaskRunning: boolean
) {
  const [hasFinishedStreaming, setHasFinishedStreaming] = useState(false);
  const wasStreamingRef = useRef(false);

  // Determine if this message should stream
  const shouldStream = isLatestAssistantMessage && isTaskRunning && !hasFinishedStreaming;

  // Track when streaming completes
  useEffect(() => {
    if (wasStreamingRef.current && !shouldStream) {
      setHasFinishedStreaming(true);
    }
    wasStreamingRef.current = shouldStream;
  }, [shouldStream]);

  // Reset if message ID changes
  useEffect(() => {
    setHasFinishedStreaming(false);
    wasStreamingRef.current = false;
  }, [messageId]);

  return {
    shouldStream,
    isComplete: !shouldStream,
    onComplete: () => setHasFinishedStreaming(true),
  };
}
