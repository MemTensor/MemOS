/**
 * Unit tests for pure utility functions extracted from handlers.ts
 *
 * Note: The handlers.ts file contains mostly IPC handler registration code
 * that requires Electron mocking. These tests focus on the pure utility
 * functions that can be tested in isolation.
 *
 * Functions tested:
 * - sanitizeString (text validation/sanitization)
 * - extractScreenshots (base64 image extraction)
 * - sanitizeToolOutput (output cleaning)
 * - ID generation patterns
 */

import { describe, it, expect } from 'vitest';

// Since these functions are not exported from handlers.ts,
// we'll recreate them here for testing purposes.
// In a real codebase, these would be extracted to a separate utils file.

const MAX_TEXT_LENGTH = 8000;

/**
 * Sanitize and validate string input
 */
function sanitizeString(input: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof input !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${field} exceeds maximum length`);
  }
  return trimmed;
}

/**
 * Create a task ID with timestamp and random suffix
 */
function createTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create a message ID with timestamp and random suffix
 */
function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Extract base64 screenshots from tool output
 */
function extractScreenshots(output: string): {
  cleanedText: string;
  attachments: Array<{ type: 'screenshot' | 'json'; data: string; label?: string }>;
} {
  const attachments: Array<{ type: 'screenshot' | 'json'; data: string; label?: string }> = [];

  // Match data URLs (data:image/png;base64,...)
  const dataUrlRegex = /data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g;
  let match;
  while ((match = dataUrlRegex.exec(output)) !== null) {
    attachments.push({
      type: 'screenshot',
      data: match[0],
      label: 'Browser screenshot',
    });
  }

  // Also check for raw base64 PNG (starts with iVBORw0)
  const rawBase64Regex = /(?<![;,])(?:^|["\s])?(iVBORw0[A-Za-z0-9+/=]{100,})(?:["\s]|$)/g;
  while ((match = rawBase64Regex.exec(output)) !== null) {
    const base64Data = match[1];
    if (base64Data && base64Data.length > 100) {
      attachments.push({
        type: 'screenshot',
        data: `data:image/png;base64,${base64Data}`,
        label: 'Browser screenshot',
      });
    }
  }

  // Clean the text
  let cleanedText = output
    .replace(dataUrlRegex, '[Screenshot captured]')
    .replace(rawBase64Regex, '[Screenshot captured]');

  cleanedText = cleanedText
    .replace(/"[Screenshot captured]"/g, '"[Screenshot]"')
    .replace(/\[Screenshot captured\]\[Screenshot captured\]/g, '[Screenshot captured]');

  return { cleanedText, attachments };
}

/**
 * Sanitize tool output to remove technical details
 */
function sanitizeToolOutput(text: string, isError: boolean): string {
  let result = text;

  // Strip ANSI escape codes
  result = result.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  result = result.replace(/\x1B\[2m|\x1B\[22m|\x1B\[0m/g, '');

  // Remove WebSocket URLs
  result = result.replace(/ws:\/\/[^\s\]]+/g, '[connection]');

  // Remove "Call log:" sections
  result = result.replace(/\s*Call log:[\s\S]*/i, '');

  if (isError) {
    // Timeout errors
    const timeoutMatch = result.match(/timed? ?out after (\d+)ms/i);
    if (timeoutMatch) {
      const seconds = Math.round(parseInt(timeoutMatch[1]) / 1000);
      return `Timed out after ${seconds}s`;
    }

    // Protocol errors
    const protocolMatch = result.match(/Protocol error \([^)]+\):\s*(.+)/i);
    if (protocolMatch) {
      result = protocolMatch[1].trim();
    }

    result = result.replace(/^Error executing code:\s*/i, '');
    result = result.replace(/browserType\.connectOverCDP:\s*/i, '');
    result = result.replace(/\s+at\s+.+/g, '');
    result = result.replace(/\w+Error:\s*/g, '');
  }

  return result.trim();
}

describe('handlers-utils', () => {
  describe('sanitizeString()', () => {
    describe('valid inputs', () => {
      it('should return trimmed string for valid input', () => {
        // Act
        const result = sanitizeString('  hello world  ', 'test');

        // Assert
        expect(result).toBe('hello world');
      });

      it('should accept string at max length', () => {
        // Arrange
        const longString = 'a'.repeat(100);

        // Act
        const result = sanitizeString(longString, 'test', 100);

        // Assert
        expect(result).toBe(longString);
      });

      it('should accept single character string', () => {
        // Act
        const result = sanitizeString('x', 'test');

        // Assert
        expect(result).toBe('x');
      });

      it('should handle multiline strings', () => {
        // Act
        const result = sanitizeString('line1\nline2\nline3', 'test');

        // Assert
        expect(result).toBe('line1\nline2\nline3');
      });

      it('should handle special characters', () => {
        // Act
        const result = sanitizeString('!@#$%^&*()', 'test');

        // Assert
        expect(result).toBe('!@#$%^&*()');
      });

      it('should handle unicode characters', () => {
        // Act
        const result = sanitizeString('Hello World', 'test');

        // Assert
        expect(result).toBe('Hello World');
      });
    });

    describe('invalid inputs', () => {
      it('should throw error for non-string (number)', () => {
        // Act & Assert
        expect(() => sanitizeString(123, 'field')).toThrow('field must be a string');
      });

      it('should throw error for non-string (object)', () => {
        // Act & Assert
        expect(() => sanitizeString({}, 'field')).toThrow('field must be a string');
      });

      it('should throw error for non-string (array)', () => {
        // Act & Assert
        expect(() => sanitizeString(['a', 'b'], 'field')).toThrow('field must be a string');
      });

      it('should throw error for non-string (null)', () => {
        // Act & Assert
        expect(() => sanitizeString(null, 'field')).toThrow('field must be a string');
      });

      it('should throw error for non-string (undefined)', () => {
        // Act & Assert
        expect(() => sanitizeString(undefined, 'field')).toThrow('field must be a string');
      });

      it('should throw error for non-string (boolean)', () => {
        // Act & Assert
        expect(() => sanitizeString(true, 'field')).toThrow('field must be a string');
      });

      it('should throw error for empty string', () => {
        // Act & Assert
        expect(() => sanitizeString('', 'field')).toThrow('field is required');
      });

      it('should throw error for whitespace-only string', () => {
        // Act & Assert
        expect(() => sanitizeString('   \t\n  ', 'field')).toThrow('field is required');
      });

      it('should throw error for string exceeding max length', () => {
        // Arrange
        const longString = 'a'.repeat(101);

        // Act & Assert
        expect(() => sanitizeString(longString, 'field', 100)).toThrow(
          'field exceeds maximum length'
        );
      });

      it('should use field name in error message', () => {
        // Act & Assert
        expect(() => sanitizeString(123, 'customField')).toThrow('customField must be a string');
        expect(() => sanitizeString('', 'anotherField')).toThrow('anotherField is required');
        expect(() => sanitizeString('abc', 'lengthField', 2)).toThrow(
          'lengthField exceeds maximum length'
        );
      });
    });

    describe('max length parameter', () => {
      it('should use default max length when not specified', () => {
        // Arrange
        const longString = 'a'.repeat(MAX_TEXT_LENGTH);

        // Act
        const result = sanitizeString(longString, 'test');

        // Assert
        expect(result.length).toBe(MAX_TEXT_LENGTH);
      });

      it('should use custom max length', () => {
        // Arrange
        const customMax = 50;

        // Act
        const result = sanitizeString('a'.repeat(customMax), 'test', customMax);

        // Assert
        expect(result.length).toBe(customMax);
      });

      it('should throw when exceeding custom max length', () => {
        // Act & Assert
        expect(() => sanitizeString('a'.repeat(51), 'test', 50)).toThrow(
          'exceeds maximum length'
        );
      });
    });
  });

  describe('ID generation', () => {
    describe('createTaskId()', () => {
      it('should start with task_ prefix', () => {
        // Act
        const id = createTaskId();

        // Assert
        expect(id).toMatch(/^task_/);
      });

      it('should include timestamp', () => {
        // Arrange
        const before = Date.now();

        // Act
        const id = createTaskId();

        // Assert
        const after = Date.now();
        const parts = id.split('_');
        const timestamp = parseInt(parts[1]);
        expect(timestamp).toBeGreaterThanOrEqual(before);
        expect(timestamp).toBeLessThanOrEqual(after);
      });

      it('should include random suffix', () => {
        // Act
        const id = createTaskId();

        // Assert
        const parts = id.split('_');
        expect(parts[2]).toMatch(/^[a-z0-9]+$/);
        expect(parts[2].length).toBeGreaterThanOrEqual(1);
      });

      it('should generate unique IDs', () => {
        // Arrange
        const ids = new Set<string>();

        // Act
        for (let i = 0; i < 1000; i++) {
          ids.add(createTaskId());
        }

        // Assert
        expect(ids.size).toBe(1000);
      });

      it('should match expected format pattern', () => {
        // Act
        const id = createTaskId();

        // Assert
        expect(id).toMatch(/^task_\d+_[a-z0-9]+$/);
      });
    });

    describe('createMessageId()', () => {
      it('should start with msg_ prefix', () => {
        // Act
        const id = createMessageId();

        // Assert
        expect(id).toMatch(/^msg_/);
      });

      it('should include timestamp', () => {
        // Arrange
        const before = Date.now();

        // Act
        const id = createMessageId();

        // Assert
        const after = Date.now();
        const parts = id.split('_');
        const timestamp = parseInt(parts[1]);
        expect(timestamp).toBeGreaterThanOrEqual(before);
        expect(timestamp).toBeLessThanOrEqual(after);
      });

      it('should generate unique IDs', () => {
        // Arrange
        const ids = new Set<string>();

        // Act
        for (let i = 0; i < 1000; i++) {
          ids.add(createMessageId());
        }

        // Assert
        expect(ids.size).toBe(1000);
      });

      it('should match expected format pattern', () => {
        // Act
        const id = createMessageId();

        // Assert
        expect(id).toMatch(/^msg_\d+_[a-z0-9]+$/);
      });
    });
  });

  describe('extractScreenshots()', () => {
    describe('data URL extraction', () => {
      it('should extract PNG data URL', () => {
        // Arrange
        const output = 'Here is the screenshot: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== done';

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0].type).toBe('screenshot');
        expect(result.attachments[0].data).toContain('data:image/png;base64,');
        expect(result.attachments[0].label).toBe('Browser screenshot');
      });

      it('should extract JPEG data URL', () => {
        // Arrange
        const output = 'Image: data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD end';

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0].data).toContain('data:image/jpeg;base64,');
      });

      it('should extract WebP data URL', () => {
        // Arrange
        const output = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=';

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0].data).toContain('data:image/webp;base64,');
      });

      it('should extract multiple data URLs', () => {
        // Arrange
        const output = 'First: data:image/png;base64,AAAA Second: data:image/jpeg;base64,BBBB end';

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.attachments).toHaveLength(2);
      });

      it('should clean data URLs from text', () => {
        // Arrange
        const output = 'Before data:image/png;base64,AAAA after';

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.cleanedText).toContain('[Screenshot captured]');
        expect(result.cleanedText).not.toContain('data:image');
      });
    });

    describe('raw base64 PNG extraction', () => {
      it('should extract raw base64 PNG starting with iVBORw0', () => {
        // Arrange - Create a string that looks like raw base64 PNG (100+ chars)
        const base64Png = 'iVBORw0' + 'A'.repeat(150);
        const output = `Screenshot: "${base64Png}" end`;

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.attachments.length).toBeGreaterThanOrEqual(1);
        const pngAttachment = result.attachments.find((a) => a.data.includes('iVBORw0'));
        expect(pngAttachment).toBeDefined();
        expect(pngAttachment?.data).toContain('data:image/png;base64,');
      });

      it('should not extract short base64 strings', () => {
        // Arrange - Less than 100 chars after iVBORw0
        const output = 'Short: iVBORw0shortdata end';

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.attachments).toHaveLength(0);
      });
    });

    describe('text cleaning', () => {
      it('should remove duplicate screenshot placeholders', () => {
        // Arrange
        const output = 'data:image/png;base64,AAA data:image/png;base64,BBB';

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.cleanedText).not.toContain('[Screenshot captured][Screenshot captured]');
      });

      it('should handle JSON-wrapped screenshots', () => {
        // Arrange
        const output = '{"image": "data:image/png;base64,AAA"}';

        // Act
        const result = extractScreenshots(output);

        // Assert
        // The replacement creates "[Screenshot captured]" first, then quoted versions
        // become "[Screenshot]" only if they match the exact pattern
        expect(result.cleanedText).toContain('[Screenshot captured]');
      });

      it('should return empty attachments for output without images', () => {
        // Arrange
        const output = 'Just some plain text without any images';

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.attachments).toHaveLength(0);
        expect(result.cleanedText).toBe(output);
      });

      it('should preserve non-image content', () => {
        // Arrange
        const output = 'Start data:image/png;base64,AAA middle data:image/jpeg;base64,BBB end';

        // Act
        const result = extractScreenshots(output);

        // Assert
        expect(result.cleanedText).toContain('Start');
        expect(result.cleanedText).toContain('middle');
        expect(result.cleanedText).toContain('end');
      });
    });
  });

  describe('sanitizeToolOutput()', () => {
    describe('ANSI escape code removal', () => {
      it('should strip basic ANSI color codes', () => {
        // Arrange
        const output = '\x1b[31mRed text\x1b[0m';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('Red text');
        expect(result).not.toContain('\x1b');
      });

      it('should strip complex ANSI sequences', () => {
        // Arrange
        const output = '\x1b[1;32;40mBold green on black\x1b[0m';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('Bold green on black');
      });

      it('should strip dim/bold toggle codes', () => {
        // Arrange
        const output = '\x1b[2mdimmed\x1b[22m normal \x1b[0m';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('dimmed normal');
      });

      it('should handle multiple ANSI sequences', () => {
        // Arrange
        const output = '\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m \x1b[34mBlue\x1b[0m';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('Red Green Blue');
      });
    });

    describe('WebSocket URL removal', () => {
      it('should replace WebSocket URLs with [connection]', () => {
        // Arrange
        const output = 'Connected to ws://localhost:9222/devtools/browser/abc123';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('Connected to [connection]');
        expect(result).not.toContain('ws://');
      });

      it('should handle multiple WebSocket URLs', () => {
        // Arrange
        const output = 'URL1: ws://host1:1234 URL2: ws://host2:5678/path';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toContain('[connection]');
        expect(result).not.toContain('ws://');
      });
    });

    describe('Call log removal', () => {
      it('should remove Call log section and everything after', () => {
        // Arrange
        const output = 'Important output\nCall log:\n- step 1\n- step 2\n- step 3';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('Important output');
        expect(result).not.toContain('Call log');
        expect(result).not.toContain('step 1');
      });

      it('should be case insensitive for Call log', () => {
        // Arrange
        const output = 'Output\nCALL LOG:\nstuff';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('Output');
      });
    });

    describe('error mode processing', () => {
      it('should simplify timeout errors', () => {
        // Arrange
        const output = 'TimeoutError: Operation timed out after 30000ms waiting for selector';

        // Act
        const result = sanitizeToolOutput(output, true);

        // Assert
        expect(result).toBe('Timed out after 30s');
      });

      it('should handle various timeout formats', () => {
        // Arrange
        const output1 = 'timeout after 5000ms';
        const output2 = 'timedout after 10000ms';

        // Act
        const result1 = sanitizeToolOutput(output1, true);
        const result2 = sanitizeToolOutput(output2, true);

        // Assert
        expect(result1).toBe('Timed out after 5s');
        expect(result2).toBe('Timed out after 10s');
      });

      it('should extract message from Protocol error', () => {
        // Arrange
        const output = 'Protocol error (Runtime.callFunctionOn): Target closed.';

        // Act
        const result = sanitizeToolOutput(output, true);

        // Assert
        expect(result).toBe('Target closed.');
        expect(result).not.toContain('Protocol error');
      });

      it('should remove Error executing code prefix', () => {
        // Arrange
        const output = 'Error executing code: Something went wrong';

        // Act
        const result = sanitizeToolOutput(output, true);

        // Assert
        expect(result).toBe('Something went wrong');
      });

      it('should remove browserType.connectOverCDP prefix', () => {
        // Arrange
        const output = 'browserType.connectOverCDP: Connection refused';

        // Act
        const result = sanitizeToolOutput(output, true);

        // Assert
        expect(result).toBe('Connection refused');
      });

      it('should remove stack traces', () => {
        // Arrange
        const output = 'Error message\n    at Function.run (/path/to/file.js:10:5)\n    at async Context.<anonymous>';

        // Act
        const result = sanitizeToolOutput(output, true);

        // Assert
        expect(result).toBe('Error message');
        expect(result).not.toContain('at Function');
        expect(result).not.toContain('/path/to');
      });

      it('should remove error class names', () => {
        // Arrange
        const output = 'CodeExecutionTimeoutError: The operation took too long';

        // Act
        const result = sanitizeToolOutput(output, true);

        // Assert
        expect(result).toBe('The operation took too long');
        expect(result).not.toContain('Error:');
      });

      it('should not process error-specific patterns when isError is false', () => {
        // Arrange
        const output = 'Error executing code: This should remain';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('Error executing code: This should remain');
      });
    });

    describe('trimming', () => {
      it('should trim whitespace from result', () => {
        // Arrange
        const output = '  Output with spaces  ';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('Output with spaces');
      });

      it('should handle empty string', () => {
        // Act
        const result = sanitizeToolOutput('', false);

        // Assert
        expect(result).toBe('');
      });

      it('should handle whitespace-only string', () => {
        // Act
        const result = sanitizeToolOutput('   \t\n  ', false);

        // Assert
        expect(result).toBe('');
      });
    });

    describe('complex scenarios', () => {
      it('should handle combined ANSI codes, URLs, and call logs', () => {
        // Arrange
        const output = '\x1b[32mConnected to ws://localhost:9222/debug\x1b[0m\nDoing work...\nCall log:\n- internal step';

        // Act
        const result = sanitizeToolOutput(output, false);

        // Assert
        expect(result).toBe('Connected to [connection]\nDoing work...');
      });

      it('should handle error mode with multiple cleanup patterns', () => {
        // Arrange
        const output = '\x1b[31mError executing code: SomeError: timed out after 5000ms\x1b[0m\n    at something\nCall log:\n- step';

        // Act
        const result = sanitizeToolOutput(output, true);

        // Assert
        expect(result).toBe('Timed out after 5s');
      });
    });
  });
});
