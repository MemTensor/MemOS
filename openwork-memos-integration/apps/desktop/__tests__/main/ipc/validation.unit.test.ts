import { describe, it, expect } from 'vitest';
import {
  validate,
  normalizeIpcError,
  taskConfigSchema,
  permissionResponseSchema,
  resumeSessionSchema,
} from '../../../src/main/ipc/validation';
import { z } from 'zod';

describe('validation.ts', () => {
  describe('validate()', () => {
    const testSchema = z.object({
      name: z.string().min(1, 'Name is required'),
      age: z.number().positive('Age must be positive'),
    });

    describe('when given valid payloads', () => {
      it('should return the parsed data for valid input', () => {
        // Arrange
        const payload = { name: 'Alice', age: 30 };

        // Act
        const result = validate(testSchema, payload);

        // Assert
        expect(result).toEqual({ name: 'Alice', age: 30 });
      });

      it('should handle schema with optional fields', () => {
        // Arrange
        const schemaWithOptional = z.object({
          required: z.string(),
          optional: z.string().optional(),
        });
        const payload = { required: 'value' };

        // Act
        const result = validate(schemaWithOptional, payload);

        // Assert
        expect(result).toEqual({ required: 'value' });
      });

      it('should handle schema with default values', () => {
        // Arrange
        const schemaWithDefault = z.object({
          value: z.string().default('default'),
        });
        const payload = {};

        // Act
        const result = validate(schemaWithDefault, payload);

        // Assert
        expect(result).toEqual({ value: 'default' });
      });
    });

    describe('when given invalid payloads', () => {
      it('should throw an error for missing required fields', () => {
        // Arrange
        const payload = { age: 30 };

        // Act & Assert
        // Note: Zod returns "Required" for missing fields by default
        expect(() => validate(testSchema, payload)).toThrow('Invalid payload: Required');
      });

      it('should throw an error for wrong types', () => {
        // Arrange
        const payload = { name: 'Alice', age: 'thirty' };

        // Act & Assert
        expect(() => validate(testSchema, payload)).toThrow('Invalid payload:');
      });

      it('should throw an error for validation constraints', () => {
        // Arrange
        const payload = { name: 'Alice', age: -5 };

        // Act & Assert
        expect(() => validate(testSchema, payload)).toThrow('Invalid payload: Age must be positive');
      });

      it('should concatenate multiple error messages with semicolons', () => {
        // Arrange
        const payload = { name: '', age: -5 };

        // Act & Assert
        expect(() => validate(testSchema, payload)).toThrow('Invalid payload:');
        try {
          validate(testSchema, payload);
        } catch (error) {
          expect((error as Error).message).toContain(';');
        }
      });

      it('should throw for null payload', () => {
        // Act & Assert
        expect(() => validate(testSchema, null)).toThrow('Invalid payload:');
      });

      it('should throw for undefined payload', () => {
        // Act & Assert
        expect(() => validate(testSchema, undefined)).toThrow('Invalid payload:');
      });
    });
  });

  describe('normalizeIpcError()', () => {
    it('should return the same Error instance if given an Error', () => {
      // Arrange
      const error = new Error('Original error');

      // Act
      const result = normalizeIpcError(error);

      // Assert
      expect(result).toBe(error);
      expect(result.message).toBe('Original error');
    });

    it('should wrap a string in an Error', () => {
      // Arrange
      const error = 'String error message';

      // Act
      const result = normalizeIpcError(error);

      // Assert
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('String error message');
    });

    it('should return "Unknown IPC error" for null', () => {
      // Act
      const result = normalizeIpcError(null);

      // Assert
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Unknown IPC error');
    });

    it('should return "Unknown IPC error" for undefined', () => {
      // Act
      const result = normalizeIpcError(undefined);

      // Assert
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Unknown IPC error');
    });

    it('should return "Unknown IPC error" for objects', () => {
      // Arrange
      const error = { message: 'Object error', code: 123 };

      // Act
      const result = normalizeIpcError(error);

      // Assert
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Unknown IPC error');
    });

    it('should return "Unknown IPC error" for numbers', () => {
      // Act
      const result = normalizeIpcError(42);

      // Assert
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Unknown IPC error');
    });

    it('should return "Unknown IPC error" for boolean', () => {
      // Act
      const result = normalizeIpcError(false);

      // Assert
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Unknown IPC error');
    });

    it('should preserve Error subclass types', () => {
      // Arrange
      class CustomError extends Error {
        code: number;
        constructor(message: string, code: number) {
          super(message);
          this.code = code;
        }
      }
      const error = new CustomError('Custom error', 500);

      // Act
      const result = normalizeIpcError(error);

      // Assert
      expect(result).toBe(error);
      expect(result).toBeInstanceOf(CustomError);
      expect((result as CustomError).code).toBe(500);
    });
  });

  describe('taskConfigSchema', () => {
    describe('valid payloads', () => {
      it('should accept minimal valid config with prompt only', () => {
        // Arrange
        const config = { prompt: 'Do something' };

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.prompt).toBe('Do something');
        }
      });

      it('should accept full config with all optional fields', () => {
        // Arrange
        const config = {
          prompt: 'Create a file',
          taskId: 'task_123',
          workingDirectory: '/home/user',
          allowedTools: ['read', 'write'],
          systemPromptAppend: 'Be concise',
          outputSchema: { type: 'object' },
          sessionId: 'session_abc',
          chrome: true,
        };

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(config);
        }
      });

      it('should accept empty arrays for allowedTools', () => {
        // Arrange
        const config = { prompt: 'Test', allowedTools: [] };

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(true);
      });

      it('should accept chrome as false', () => {
        // Arrange
        const config = { prompt: 'Test', chrome: false };

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.chrome).toBe(false);
        }
      });
    });

    describe('invalid payloads', () => {
      it('should reject empty prompt', () => {
        // Arrange
        const config = { prompt: '' };

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe('Prompt is required');
        }
      });

      it('should reject missing prompt', () => {
        // Arrange
        const config = {};

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(false);
      });

      it('should accept prompt with only whitespace (min(1) allows whitespace)', () => {
        // Arrange
        const config = { prompt: '   ' };

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        // Note: z.string().min(1) only checks length, not trimmed content
        // The sanitization of whitespace-only strings happens in validateTaskConfig()
        expect(result.success).toBe(true);
      });

      it('should reject non-string prompt', () => {
        // Arrange
        const config = { prompt: 123 };

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(false);
      });

      it('should reject non-array allowedTools', () => {
        // Arrange
        const config = { prompt: 'Test', allowedTools: 'read,write' };

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(false);
      });

      it('should reject non-boolean chrome', () => {
        // Arrange
        const config = { prompt: 'Test', chrome: 'yes' };

        // Act
        const result = taskConfigSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });

  describe('permissionResponseSchema', () => {
    describe('valid payloads', () => {
      it('should accept minimal allow response', () => {
        // Arrange
        const response = {
          requestId: 'req_123',
          taskId: 'task_456',
          decision: 'allow',
        };

        // Act
        const result = permissionResponseSchema.safeParse(response);

        // Assert
        expect(result.success).toBe(true);
      });

      it('should accept minimal deny response', () => {
        // Arrange
        const response = {
          requestId: 'req_123',
          taskId: 'task_456',
          decision: 'deny',
        };

        // Act
        const result = permissionResponseSchema.safeParse(response);

        // Assert
        expect(result.success).toBe(true);
      });

      it('should accept response with message', () => {
        // Arrange
        const response = {
          requestId: 'req_123',
          taskId: 'task_456',
          decision: 'allow',
          message: 'User approved',
        };

        // Act
        const result = permissionResponseSchema.safeParse(response);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.message).toBe('User approved');
        }
      });

      it('should accept response with selectedOptions', () => {
        // Arrange
        const response = {
          requestId: 'req_123',
          taskId: 'task_456',
          decision: 'allow',
          selectedOptions: ['option1', 'option2'],
        };

        // Act
        const result = permissionResponseSchema.safeParse(response);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.selectedOptions).toEqual(['option1', 'option2']);
        }
      });
    });

    describe('invalid payloads', () => {
      it('should reject empty requestId', () => {
        // Arrange
        const response = {
          requestId: '',
          taskId: 'task_456',
          decision: 'allow',
        };

        // Act
        const result = permissionResponseSchema.safeParse(response);

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe('Request ID is required');
        }
      });

      it('should reject empty taskId', () => {
        // Arrange
        const response = {
          requestId: 'req_123',
          taskId: '',
          decision: 'allow',
        };

        // Act
        const result = permissionResponseSchema.safeParse(response);

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe('Task ID is required');
        }
      });

      it('should reject invalid decision', () => {
        // Arrange
        const response = {
          requestId: 'req_123',
          taskId: 'task_456',
          decision: 'maybe',
        };

        // Act
        const result = permissionResponseSchema.safeParse(response);

        // Assert
        expect(result.success).toBe(false);
      });

      it('should reject missing decision', () => {
        // Arrange
        const response = {
          requestId: 'req_123',
          taskId: 'task_456',
        };

        // Act
        const result = permissionResponseSchema.safeParse(response);

        // Assert
        expect(result.success).toBe(false);
      });

      it('should reject non-array selectedOptions', () => {
        // Arrange
        const response = {
          requestId: 'req_123',
          taskId: 'task_456',
          decision: 'allow',
          selectedOptions: 'option1,option2',
        };

        // Act
        const result = permissionResponseSchema.safeParse(response);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });

  describe('resumeSessionSchema', () => {
    describe('valid payloads', () => {
      it('should accept minimal resume config', () => {
        // Arrange
        const config = {
          sessionId: 'session_abc',
          prompt: 'Continue the task',
        };

        // Act
        const result = resumeSessionSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(config);
        }
      });

      it('should accept resume config with existingTaskId', () => {
        // Arrange
        const config = {
          sessionId: 'session_abc',
          prompt: 'Continue the task',
          existingTaskId: 'task_123',
        };

        // Act
        const result = resumeSessionSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.existingTaskId).toBe('task_123');
        }
      });

      it('should accept resume config with chrome flag', () => {
        // Arrange
        const config = {
          sessionId: 'session_abc',
          prompt: 'Continue the task',
          chrome: true,
        };

        // Act
        const result = resumeSessionSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.chrome).toBe(true);
        }
      });
    });

    describe('invalid payloads', () => {
      it('should reject empty sessionId', () => {
        // Arrange
        const config = {
          sessionId: '',
          prompt: 'Continue',
        };

        // Act
        const result = resumeSessionSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe('Session ID is required');
        }
      });

      it('should reject empty prompt', () => {
        // Arrange
        const config = {
          sessionId: 'session_abc',
          prompt: '',
        };

        // Act
        const result = resumeSessionSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe('Prompt is required');
        }
      });

      it('should reject missing sessionId', () => {
        // Arrange
        const config = {
          prompt: 'Continue',
        };

        // Act
        const result = resumeSessionSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(false);
      });

      it('should reject missing prompt', () => {
        // Arrange
        const config = {
          sessionId: 'session_abc',
        };

        // Act
        const result = resumeSessionSchema.safeParse(config);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });
});
