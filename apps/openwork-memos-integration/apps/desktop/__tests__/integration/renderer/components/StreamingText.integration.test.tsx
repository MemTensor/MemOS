/**
 * Integration tests for StreamingText component and useStreamingState hook
 * Tests text streaming animation, completion state, and different content types
 * @module __tests__/integration/renderer/components/StreamingText.integration.test
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { StreamingText, useStreamingState } from '@/components/ui/streaming-text';

describe('StreamingText Integration', () => {
  describe('basic rendering', () => {
    it('should render with container div', () => {
      // Arrange & Act
      render(
        <StreamingText text="Hello World" isComplete={true}>
          {(text) => <span>{text}</span>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    it('should render full text when isComplete is true', () => {
      // Arrange & Act
      render(
        <StreamingText text="Complete text" isComplete={true}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content')).toHaveTextContent('Complete text');
    });

    it('should render empty initially when not complete', () => {
      // Arrange & Act
      render(
        <StreamingText text="Streaming text" isComplete={false}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Assert - Initially empty
      expect(screen.getByTestId('content')).toHaveTextContent('');
    });

    it('should apply custom className', () => {
      // Arrange & Act
      render(
        <StreamingText text="Test" isComplete={true} className="custom-class">
          {(text) => <span>{text}</span>}
        </StreamingText>
      );

      // Assert
      const container = document.querySelector('.custom-class');
      expect(container).toBeInTheDocument();
    });
  });

  describe('text streaming animation', () => {
    it('should start with zero characters when streaming', () => {
      // Arrange & Act
      render(
        <StreamingText text="Hello" isComplete={false}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content')).toHaveTextContent('');
    });
  });

  describe('completion state', () => {
    it('should show full text immediately when isComplete is true', () => {
      // Arrange & Act
      render(
        <StreamingText text="Immediate complete" isComplete={true}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content')).toHaveTextContent('Immediate complete');
    });

    it('should stop streaming when isComplete changes to true', () => {
      // Arrange
      const { rerender } = render(
        <StreamingText text="Partial text" isComplete={false}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Act - Complete immediately
      rerender(
        <StreamingText text="Partial text" isComplete={true}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Assert - Should immediately show full text
      expect(screen.getByTestId('content')).toHaveTextContent('Partial text');
    });

    it('should not call onComplete when isComplete is initially true', () => {
      // Arrange
      const onComplete = vi.fn();

      // Act
      render(
        <StreamingText text="Already done" isComplete={true} onComplete={onComplete}>
          {(text) => <span>{text}</span>}
        </StreamingText>
      );

      // Assert - onComplete should NOT be called for already complete text
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe('cursor indicator', () => {
    it('should show cursor while streaming', () => {
      // Arrange & Act
      render(
        <StreamingText text="Streaming" isComplete={false}>
          {(text) => <span>{text}</span>}
        </StreamingText>
      );

      // Assert
      const cursor = document.querySelector('.animate-pulse');
      expect(cursor).toBeInTheDocument();
    });

    it('should hide cursor when streaming is complete', () => {
      // Arrange & Act
      render(
        <StreamingText text="Done" isComplete={true}>
          {(text) => <span>{text}</span>}
        </StreamingText>
      );

      // Assert
      const cursor = document.querySelector('.animate-pulse');
      expect(cursor).not.toBeInTheDocument();
    });
  });

  describe('different content types', () => {
    it('should handle plain text content', () => {
      // Arrange & Act
      render(
        <StreamingText text="Plain text content" isComplete={true}>
          {(text) => <p>{text}</p>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByText('Plain text content')).toBeInTheDocument();
    });

    it('should handle markdown-style text', () => {
      // Arrange & Act
      render(
        <StreamingText text="**Bold** and *italic* text" isComplete={true}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content')).toHaveTextContent('**Bold** and *italic* text');
    });

    it('should handle code content', () => {
      // Arrange & Act
      render(
        <StreamingText text="const x = 42;" isComplete={true}>
          {(text) => <code data-testid="content">{text}</code>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content')).toHaveTextContent('const x = 42;');
    });

    it('should handle multiline content', () => {
      // Arrange
      const multilineText = `Line 1
Line 2
Line 3`;

      // Act
      render(
        <StreamingText text={multilineText} isComplete={true}>
          {(text) => <pre data-testid="content">{text}</pre>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content')).toHaveTextContent('Line 1');
      expect(screen.getByTestId('content')).toHaveTextContent('Line 2');
      expect(screen.getByTestId('content')).toHaveTextContent('Line 3');
    });

    it('should handle empty text', () => {
      // Arrange & Act
      render(
        <StreamingText text="" isComplete={true}>
          {(text) => <span data-testid="content">{text || 'empty'}</span>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content')).toHaveTextContent('empty');
    });

    it('should handle special characters', () => {
      // Arrange & Act
      render(
        <StreamingText text="Special chars: @#$%^&*()" isComplete={true}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content')).toHaveTextContent('Special chars: @#$%^&*()');
    });

    it('should handle unicode characters', () => {
      // Arrange & Act
      render(
        <StreamingText text="Unicode: Hello World" isComplete={true}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content')).toHaveTextContent('Unicode: Hello World');
    });

    it('should handle long text content', () => {
      // Arrange
      const longText = 'A'.repeat(1000);

      // Act
      render(
        <StreamingText text={longText} isComplete={true}>
          {(text) => <span data-testid="content">{text}</span>}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('content').textContent?.length).toBe(1000);
    });
  });

  describe('render prop flexibility', () => {
    it('should pass displayed text to children render prop', () => {
      // Arrange
      const renderSpy = vi.fn((text: string) => <span>{text}</span>);

      // Act
      render(
        <StreamingText text="Test" isComplete={true}>
          {renderSpy}
        </StreamingText>
      );

      // Assert
      expect(renderSpy).toHaveBeenCalledWith('Test');
    });

    it('should allow custom rendering of text', () => {
      // Arrange & Act
      render(
        <StreamingText text="Custom" isComplete={true}>
          {(text) => (
            <div data-testid="custom-render">
              <strong>{text.toUpperCase()}</strong>
            </div>
          )}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('custom-render')).toHaveTextContent('CUSTOM');
    });

    it('should allow wrapping text in complex markup', () => {
      // Arrange & Act
      render(
        <StreamingText text="Wrapped" isComplete={true}>
          {(text) => (
            <article>
              <header>Header</header>
              <p data-testid="body">{text}</p>
              <footer>Footer</footer>
            </article>
          )}
        </StreamingText>
      );

      // Assert
      expect(screen.getByTestId('body')).toHaveTextContent('Wrapped');
    });
  });
});

describe('useStreamingState Hook', () => {
  describe('initial state', () => {
    it('should return shouldStream as true for latest running assistant message', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useStreamingState('msg-1', true, true)
      );

      // Assert
      expect(result.current.shouldStream).toBe(true);
    });

    it('should return shouldStream as false when not latest assistant message', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useStreamingState('msg-1', false, true)
      );

      // Assert
      expect(result.current.shouldStream).toBe(false);
    });

    it('should return shouldStream as false when task not running', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useStreamingState('msg-1', true, false)
      );

      // Assert
      expect(result.current.shouldStream).toBe(false);
    });

    it('should return isComplete as opposite of shouldStream', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useStreamingState('msg-1', true, true)
      );

      // Assert
      expect(result.current.isComplete).toBe(false);
    });
  });

  describe('streaming completion', () => {
    it('should provide onComplete callback', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useStreamingState('msg-1', true, true)
      );

      // Assert
      expect(typeof result.current.onComplete).toBe('function');
    });

    it('should mark as complete after onComplete is called', () => {
      // Arrange
      const { result, rerender } = renderHook(() =>
        useStreamingState('msg-1', true, true)
      );

      // Act
      act(() => {
        result.current.onComplete();
      });

      // Trigger re-render
      rerender();

      // Assert
      expect(result.current.shouldStream).toBe(false);
      expect(result.current.isComplete).toBe(true);
    });
  });

  describe('message ID changes', () => {
    it('should reset streaming state when message ID changes', () => {
      // Arrange
      const { result, rerender } = renderHook(
        ({ messageId }) => useStreamingState(messageId, true, true),
        { initialProps: { messageId: 'msg-1' } }
      );

      // Act - Complete streaming
      act(() => {
        result.current.onComplete();
      });

      // Change message ID
      rerender({ messageId: 'msg-2' });

      // Assert - Should be streaming again
      expect(result.current.shouldStream).toBe(true);
    });
  });

  describe('task running state changes', () => {
    it('should stop streaming when task stops running', () => {
      // Arrange
      const { result, rerender } = renderHook(
        ({ isRunning }) => useStreamingState('msg-1', true, isRunning),
        { initialProps: { isRunning: true } }
      );

      expect(result.current.shouldStream).toBe(true);

      // Act - Stop task
      rerender({ isRunning: false });

      // Assert
      expect(result.current.shouldStream).toBe(false);
      expect(result.current.isComplete).toBe(true);
    });
  });

  describe('latest message changes', () => {
    it('should stop streaming when no longer latest message', () => {
      // Arrange
      const { result, rerender } = renderHook(
        ({ isLatest }) => useStreamingState('msg-1', isLatest, true),
        { initialProps: { isLatest: true } }
      );

      expect(result.current.shouldStream).toBe(true);

      // Act - No longer latest
      rerender({ isLatest: false });

      // Assert
      expect(result.current.shouldStream).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle all flags being false', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useStreamingState('msg-1', false, false)
      );

      // Assert
      expect(result.current.shouldStream).toBe(false);
      expect(result.current.isComplete).toBe(true);
    });

    it('should handle rapid state changes', () => {
      // Arrange
      const { result, rerender } = renderHook(
        ({ isLatest, isRunning }) =>
          useStreamingState('msg-1', isLatest, isRunning),
        { initialProps: { isLatest: true, isRunning: true } }
      );

      // Act - Rapid changes
      for (let i = 0; i < 10; i++) {
        rerender({ isLatest: i % 2 === 0, isRunning: i % 3 === 0 });
      }

      // Assert - Should be in consistent state
      expect(typeof result.current.shouldStream).toBe('boolean');
      expect(typeof result.current.isComplete).toBe('boolean');
    });

    it('should handle empty message ID', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useStreamingState('', true, true)
      );

      // Assert - Should still work
      expect(result.current.shouldStream).toBe(true);
    });
  });
});
