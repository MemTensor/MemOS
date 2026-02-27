import { describe, it, expect } from 'vitest';
import { cn } from '../../../src/renderer/lib/utils';

describe('utils.ts', () => {
  describe('cn() - class name merging', () => {
    describe('basic usage', () => {
      it('should return single class unchanged', () => {
        // Act
        const result = cn('text-red-500');

        // Assert
        expect(result).toBe('text-red-500');
      });

      it('should merge multiple classes', () => {
        // Act
        const result = cn('text-red-500', 'bg-white');

        // Assert
        expect(result).toBe('text-red-500 bg-white');
      });

      it('should handle empty string inputs', () => {
        // Act
        const result = cn('', 'text-red-500', '');

        // Assert
        expect(result).toBe('text-red-500');
      });

      it('should handle no arguments', () => {
        // Act
        const result = cn();

        // Assert
        expect(result).toBe('');
      });

      it('should handle single empty string', () => {
        // Act
        const result = cn('');

        // Assert
        expect(result).toBe('');
      });
    });

    describe('conditional classes with clsx', () => {
      it('should include class when condition is true', () => {
        // Arrange
        const isActive = true;

        // Act
        const result = cn('base', isActive && 'active');

        // Assert
        expect(result).toBe('base active');
      });

      it('should exclude class when condition is false', () => {
        // Arrange
        const isActive = false;

        // Act
        const result = cn('base', isActive && 'active');

        // Assert
        expect(result).toBe('base');
      });

      it('should handle object syntax for conditionals', () => {
        // Arrange
        const isActive = true;
        const isDisabled = false;

        // Act
        const result = cn('base', {
          active: isActive,
          disabled: isDisabled,
        });

        // Assert
        expect(result).toBe('base active');
      });

      it('should handle array of classes', () => {
        // Act
        const result = cn(['text-red-500', 'bg-white']);

        // Assert
        expect(result).toBe('text-red-500 bg-white');
      });

      it('should handle nested arrays', () => {
        // Act
        const result = cn(['base', ['nested1', 'nested2']]);

        // Assert
        expect(result).toBe('base nested1 nested2');
      });

      it('should handle null and undefined values', () => {
        // Act
        const result = cn('base', null, undefined, 'end');

        // Assert
        expect(result).toBe('base end');
      });

      it('should handle false and 0 values', () => {
        // Act
        const result = cn('base', false, 0, 'end');

        // Assert
        expect(result).toBe('base end');
      });
    });

    describe('Tailwind conflict resolution', () => {
      it('should resolve conflicting padding classes (later wins)', () => {
        // Act
        const result = cn('p-4', 'p-8');

        // Assert
        expect(result).toBe('p-8');
      });

      it('should resolve conflicting margin classes', () => {
        // Act
        const result = cn('m-2', 'm-4');

        // Assert
        expect(result).toBe('m-4');
      });

      it('should resolve conflicting text color classes', () => {
        // Act
        const result = cn('text-red-500', 'text-blue-500');

        // Assert
        expect(result).toBe('text-blue-500');
      });

      it('should resolve conflicting background color classes', () => {
        // Act
        const result = cn('bg-white', 'bg-black');

        // Assert
        expect(result).toBe('bg-black');
      });

      it('should not merge non-conflicting classes', () => {
        // Act
        const result = cn('text-red-500', 'bg-white', 'p-4');

        // Assert
        expect(result).toBe('text-red-500 bg-white p-4');
      });

      it('should resolve conflicting font size classes', () => {
        // Act
        const result = cn('text-sm', 'text-lg');

        // Assert
        expect(result).toBe('text-lg');
      });

      it('should resolve conflicting font weight classes', () => {
        // Act
        const result = cn('font-normal', 'font-bold');

        // Assert
        expect(result).toBe('font-bold');
      });

      it('should resolve conflicting display classes', () => {
        // Act
        const result = cn('block', 'flex');

        // Assert
        expect(result).toBe('flex');
      });

      it('should resolve conflicting width classes', () => {
        // Act
        const result = cn('w-full', 'w-1/2');

        // Assert
        expect(result).toBe('w-1/2');
      });

      it('should resolve conflicting height classes', () => {
        // Act
        const result = cn('h-10', 'h-20');

        // Assert
        expect(result).toBe('h-20');
      });

      it('should handle directional padding without conflict', () => {
        // Act
        const result = cn('px-4', 'py-2');

        // Assert
        expect(result).toBe('px-4 py-2');
      });

      it('should resolve px vs px conflicts', () => {
        // Act
        const result = cn('px-4', 'px-8');

        // Assert
        expect(result).toBe('px-8');
      });

      it('should not confuse px with p', () => {
        // Act
        const result = cn('p-4', 'px-8');

        // Assert
        expect(result).toContain('p-4');
        expect(result).toContain('px-8');
      });

      it('should resolve conflicting rounded classes', () => {
        // Act
        const result = cn('rounded', 'rounded-lg');

        // Assert
        expect(result).toBe('rounded-lg');
      });

      it('should resolve conflicting border classes', () => {
        // Act
        const result = cn('border', 'border-2');

        // Assert
        expect(result).toBe('border-2');
      });

      it('should resolve conflicting z-index classes', () => {
        // Act
        const result = cn('z-10', 'z-50');

        // Assert
        expect(result).toBe('z-50');
      });
    });

    describe('responsive and state variants', () => {
      it('should handle responsive prefixes', () => {
        // Act
        const result = cn('text-sm', 'md:text-base', 'lg:text-lg');

        // Assert
        expect(result).toBe('text-sm md:text-base lg:text-lg');
      });

      it('should resolve conflicts within same breakpoint', () => {
        // Act
        const result = cn('md:text-sm', 'md:text-lg');

        // Assert
        expect(result).toBe('md:text-lg');
      });

      it('should handle hover states', () => {
        // Act
        const result = cn('bg-white', 'hover:bg-gray-100');

        // Assert
        expect(result).toBe('bg-white hover:bg-gray-100');
      });

      it('should resolve hover state conflicts', () => {
        // Act
        const result = cn('hover:bg-gray-100', 'hover:bg-gray-200');

        // Assert
        expect(result).toBe('hover:bg-gray-200');
      });

      it('should handle focus states', () => {
        // Act
        const result = cn('outline-none', 'focus:outline-2');

        // Assert
        expect(result).toBe('outline-none focus:outline-2');
      });

      it('should handle dark mode', () => {
        // Act
        const result = cn('bg-white', 'dark:bg-gray-900');

        // Assert
        expect(result).toBe('bg-white dark:bg-gray-900');
      });
    });

    describe('complex real-world usage', () => {
      it('should handle button variant pattern', () => {
        // Arrange
        const baseClasses = 'px-4 py-2 rounded font-medium';
        const variantClasses = 'bg-blue-500 text-white hover:bg-blue-600';
        const sizeOverride = 'px-6 py-3';

        // Act
        const result = cn(baseClasses, variantClasses, sizeOverride);

        // Assert
        expect(result).toContain('px-6');
        expect(result).toContain('py-3');
        expect(result).toContain('rounded');
        expect(result).toContain('font-medium');
        expect(result).toContain('bg-blue-500');
        expect(result).not.toContain('px-4');
        expect(result).not.toContain('py-2');
      });

      it('should handle conditional disabled state', () => {
        // Arrange
        const isDisabled = true;
        const baseClasses = 'bg-blue-500 cursor-pointer';
        const disabledClasses = isDisabled && 'bg-gray-300 cursor-not-allowed';

        // Act
        const result = cn(baseClasses, disabledClasses);

        // Assert
        expect(result).toContain('bg-gray-300');
        expect(result).toContain('cursor-not-allowed');
        expect(result).not.toContain('bg-blue-500');
        expect(result).not.toContain('cursor-pointer');
      });

      it('should handle component prop className override', () => {
        // Arrange - simulating component with default + user override
        const defaultClasses = 'text-sm text-gray-500';
        const userClassName = 'text-lg text-blue-500';

        // Act
        const result = cn(defaultClasses, userClassName);

        // Assert
        expect(result).toBe('text-lg text-blue-500');
      });

      it('should handle mixed array and string inputs', () => {
        // Arrange
        const conditionalClasses = ['rounded-lg', 'shadow-md'];
        const isLarge = true;

        // Act
        const result = cn('base', conditionalClasses, isLarge && 'w-full');

        // Assert
        expect(result).toBe('base rounded-lg shadow-md w-full');
      });

      it('should handle arbitrary values', () => {
        // Act
        const result = cn('w-[200px]', 'h-[100px]');

        // Assert
        expect(result).toBe('w-[200px] h-[100px]');
      });

      it('should resolve arbitrary value conflicts', () => {
        // Act
        const result = cn('w-[200px]', 'w-[300px]');

        // Assert
        expect(result).toBe('w-[300px]');
      });
    });

    describe('edge cases', () => {
      it('should handle classes with numbers', () => {
        // Act
        const result = cn('grid-cols-3', 'gap-4');

        // Assert
        expect(result).toBe('grid-cols-3 gap-4');
      });

      it('should handle negative values', () => {
        // Act
        const result = cn('-mt-4', '-ml-2');

        // Assert
        expect(result).toBe('-mt-4 -ml-2');
      });

      it('should handle important modifier', () => {
        // Act
        const result = cn('!text-red-500', '!bg-white');

        // Assert
        expect(result).toBe('!text-red-500 !bg-white');
      });

      it('should handle whitespace in class strings', () => {
        // Act
        const result = cn('  text-red-500  ', '  bg-white  ');

        // Assert
        expect(result).toBe('text-red-500 bg-white');
      });

      it('should handle multiple spaces between classes', () => {
        // Act
        const result = cn('text-red-500   bg-white');

        // Assert
        expect(result).toBe('text-red-500 bg-white');
      });

      it('should handle deeply nested conditionals', () => {
        // Arrange
        const a = true;
        const b = false;
        const c = true;

        // Act
        const result = cn(
          'base',
          a && 'a-true',
          b && 'b-true',
          c && ['c-true', b && 'cb-true']
        );

        // Assert
        expect(result).toBe('base a-true c-true');
      });
    });
  });
});
