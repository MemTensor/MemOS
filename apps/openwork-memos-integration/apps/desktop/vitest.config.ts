import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  test: {
    globals: true,
    root: __dirname,
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**', '**/release/**'],
    setupFiles: ['__tests__/setup.ts'],
    // Use different environments based on test type
    // Unit tests for main process use Node environment
    // Unit tests for renderer use jsdom
    environment: 'node',
    environmentMatchGlobs: [
      // Renderer tests use jsdom for DOM APIs
      ['__tests__/**/*.renderer.*.test.{ts,tsx}', 'jsdom'],
      ['__tests__/**/renderer/**/*.test.{ts,tsx}', 'jsdom'],
    ],
    coverage: {
      provider: 'v8',
      enabled: false, // Enable via CLI with --coverage
      reporter: ['text', 'html', 'lcov', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/index.ts',
        'src/vite-env.d.ts',
        'src/renderer/main.tsx',
        '**/node_modules/**',
        // Thin UI wrappers (Radix UI components with only styling, no business logic)
        'src/renderer/components/ui/avatar.tsx',
        'src/renderer/components/ui/badge.tsx',
        'src/renderer/components/ui/card.tsx',
        'src/renderer/components/ui/dialog.tsx',
        'src/renderer/components/ui/dropdown-menu.tsx',
        'src/renderer/components/ui/label.tsx',
        'src/renderer/components/ui/separator.tsx',
        'src/renderer/components/ui/skeleton.tsx',
        'src/renderer/components/ui/textarea.tsx',
        'src/renderer/components/ui/tooltip.tsx',
        'src/renderer/components/ui/popover.tsx',
        'src/renderer/components/ui/select.tsx',
        // Simple page wrappers
        'src/renderer/pages/History.tsx',
        // Infrastructure code - HTTP server and file system cleanup utilities
        'src/main/permission-api.ts', // MCP permission HTTP server - infrastructure
        'src/main/store/freshInstallCleanup.ts', // One-time cleanup utility
        // E2E test utilities - not production code
        'src/main/test-utils/**',
      ],
      thresholds: {
        statements: 80,
        branches: 70, // Branch coverage is harder to achieve with complex conditionals
        functions: 80,
        lines: 80,
      },
    },
    // Timeout for individual tests (5 seconds)
    testTimeout: 5000,
    // Timeout for hooks (10 seconds)
    hookTimeout: 10000,
    // Retry failed tests once
    retry: 0,
    // Reporter configuration
    reporters: ['default'],
    // Watch mode configuration
    watch: false,
  },
});
