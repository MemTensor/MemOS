/**
 * Unit tests for Analytics library
 *
 * Tests the analytics tracking utilities:
 * - trackPageView() and trackEvent() behavior
 * - No-op behavior when gtag is unavailable
 * - Correct gtag calls when available
 * - All predefined event trackers in the analytics object
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock window.gtag before importing the module
const mockGtag = vi.fn();

// Set up window mock
const originalWindow = globalThis.window;

describe('Analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    (globalThis as unknown as { window: typeof window }).window = {
      ...originalWindow,
      gtag: undefined,
    } as unknown as typeof window;
  });

  afterEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { window: typeof window }).window = originalWindow;
  });

  describe('trackPageView', () => {
    it('should not throw when gtag is unavailable', async () => {
      (globalThis as unknown as { window: { gtag?: unknown } }).window = { gtag: undefined };

      const { trackPageView } = await import('@renderer/lib/analytics');
      // Should not throw - just returns without error
      expect(() => trackPageView('/test-page', 'Test Page')).not.toThrow();
    });

    it('should call gtag with correct parameters when available', async () => {
      (globalThis as unknown as { window: { gtag: typeof mockGtag } }).window = { gtag: mockGtag };

      const { trackPageView } = await import('@renderer/lib/analytics');
      trackPageView('/test-page', 'Test Page');

      expect(mockGtag).toHaveBeenCalledWith('config', 'G-RQWHYJ5NEG', {
        page_path: '/test-page',
        page_title: 'Test Page',
      });
    });

    it('should handle missing page title', async () => {
      (globalThis as unknown as { window: { gtag: typeof mockGtag } }).window = { gtag: mockGtag };

      const { trackPageView } = await import('@renderer/lib/analytics');
      trackPageView('/test-page');

      expect(mockGtag).toHaveBeenCalledWith('config', 'G-RQWHYJ5NEG', {
        page_path: '/test-page',
        page_title: undefined,
      });
    });

    it('should return immediately if gtag is not a function', async () => {
      (globalThis as unknown as { window: { gtag: string } }).window = { gtag: 'not a function' };

      const { trackPageView } = await import('@renderer/lib/analytics');
      const result = trackPageView('/test-page');

      expect(result).toBeUndefined();
    });
  });

  describe('trackEvent', () => {
    it('should not throw when gtag is unavailable', async () => {
      (globalThis as unknown as { window: { gtag?: unknown } }).window = { gtag: undefined };

      const { trackEvent } = await import('@renderer/lib/analytics');
      expect(() => trackEvent('test_event', { category: 'test' })).not.toThrow();
    });

    it('should call gtag with event name and parameters', async () => {
      (globalThis as unknown as { window: { gtag: typeof mockGtag } }).window = { gtag: mockGtag };

      const { trackEvent } = await import('@renderer/lib/analytics');
      trackEvent('test_event', { category: 'test', value: 123 });

      expect(mockGtag).toHaveBeenCalledWith('event', 'test_event', {
        category: 'test',
        value: 123,
      });
    });

    it('should handle events without parameters', async () => {
      (globalThis as unknown as { window: { gtag: typeof mockGtag } }).window = { gtag: mockGtag };

      const { trackEvent } = await import('@renderer/lib/analytics');
      trackEvent('simple_event');

      expect(mockGtag).toHaveBeenCalledWith('event', 'simple_event', undefined);
    });
  });

  describe('Predefined Event Trackers', () => {
    beforeEach(async () => {
      vi.resetModules();
      (globalThis as unknown as { window: { gtag: typeof mockGtag } }).window = { gtag: mockGtag };
    });

    it('trackSubmitTask should call gtag with correct parameters', async () => {
      const { analytics } = await import('@renderer/lib/analytics');
      analytics.trackSubmitTask();

      expect(mockGtag).toHaveBeenCalledWith('event', 'submit_task', {
        event_category: 'engagement',
        event_label: 'task_submission',
      });
    });

    it('trackNewTask should call gtag with correct parameters', async () => {
      const { analytics } = await import('@renderer/lib/analytics');
      analytics.trackNewTask();

      expect(mockGtag).toHaveBeenCalledWith('event', 'new_task', {
        event_category: 'engagement',
        event_label: 'new_task_click',
      });
    });

    it('trackOpenSettings should call gtag with correct parameters', async () => {
      const { analytics } = await import('@renderer/lib/analytics');
      analytics.trackOpenSettings();

      expect(mockGtag).toHaveBeenCalledWith('event', 'open_settings', {
        event_category: 'engagement',
        event_label: 'settings_click',
      });
    });

    it('trackSaveApiKey should include provider parameter', async () => {
      const { analytics } = await import('@renderer/lib/analytics');
      analytics.trackSaveApiKey('anthropic');

      expect(mockGtag).toHaveBeenCalledWith('event', 'save_api_key', {
        event_category: 'settings',
        event_label: 'api_key_save',
        provider: 'anthropic',
      });
    });

    it('trackSelectProvider should include provider parameter', async () => {
      const { analytics } = await import('@renderer/lib/analytics');
      analytics.trackSelectProvider('openai');

      expect(mockGtag).toHaveBeenCalledWith('event', 'select_provider', {
        event_category: 'settings',
        event_label: 'provider_selection',
        provider: 'openai',
      });
    });

    it('trackSelectModel should include model parameter', async () => {
      const { analytics } = await import('@renderer/lib/analytics');
      analytics.trackSelectModel('claude-3-sonnet');

      expect(mockGtag).toHaveBeenCalledWith('event', 'select_model', {
        event_category: 'settings',
        event_label: 'model_selection',
        model: 'claude-3-sonnet',
      });
    });

    it('trackToggleDebugMode should include enabled flag', async () => {
      const { analytics } = await import('@renderer/lib/analytics');

      analytics.trackToggleDebugMode(true);
      expect(mockGtag).toHaveBeenCalledWith('event', 'toggle_debug_mode', {
        event_category: 'settings',
        event_label: 'debug_mode_toggle',
        enabled: true,
      });

      mockGtag.mockClear();

      analytics.trackToggleDebugMode(false);
      expect(mockGtag).toHaveBeenCalledWith('event', 'toggle_debug_mode', {
        event_category: 'settings',
        event_label: 'debug_mode_toggle',
        enabled: false,
      });
    });
  });

  describe('Analytics Object Structure', () => {
    it('should expose all required tracker functions', async () => {
      const { analytics } = await import('@renderer/lib/analytics');

      expect(typeof analytics.trackPageView).toBe('function');
      expect(typeof analytics.trackEvent).toBe('function');
      expect(typeof analytics.trackSubmitTask).toBe('function');
      expect(typeof analytics.trackNewTask).toBe('function');
      expect(typeof analytics.trackOpenSettings).toBe('function');
      expect(typeof analytics.trackSaveApiKey).toBe('function');
      expect(typeof analytics.trackSelectProvider).toBe('function');
      expect(typeof analytics.trackSelectModel).toBe('function');
      expect(typeof analytics.trackToggleDebugMode).toBe('function');
    });

    it('should export analytics object as default', async () => {
      const analyticsDefault = (await import('@renderer/lib/analytics')).default;
      expect(analyticsDefault).toBeDefined();
      expect(analyticsDefault.trackSubmitTask).toBeDefined();
      expect(analyticsDefault.trackPageView).toBeDefined();
    });
  });

  describe('Event Categories', () => {
    beforeEach(async () => {
      vi.resetModules();
      (globalThis as unknown as { window: { gtag: typeof mockGtag } }).window = { gtag: mockGtag };
    });

    it('should use engagement category for user actions', async () => {
      const { analytics } = await import('@renderer/lib/analytics');
      analytics.trackSubmitTask();
      analytics.trackNewTask();
      analytics.trackOpenSettings();

      const engagementCalls = mockGtag.mock.calls.filter(
        (call) => call[2]?.event_category === 'engagement'
      );
      expect(engagementCalls).toHaveLength(3);
    });

    it('should use settings category for configuration changes', async () => {
      const { analytics } = await import('@renderer/lib/analytics');
      analytics.trackSaveApiKey('anthropic');
      analytics.trackSelectProvider('openai');
      analytics.trackSelectModel('gpt-4');
      analytics.trackToggleDebugMode(true);

      const settingsCalls = mockGtag.mock.calls.filter(
        (call) => call[2]?.event_category === 'settings'
      );
      expect(settingsCalls).toHaveLength(4);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null gtag gracefully', async () => {
      (globalThis as unknown as { window: { gtag: null } }).window = { gtag: null };

      const { trackEvent } = await import('@renderer/lib/analytics');
      expect(() => trackEvent('test')).not.toThrow();
    });

    it('should handle empty event name', async () => {
      (globalThis as unknown as { window: { gtag: typeof mockGtag } }).window = { gtag: mockGtag };

      const { trackEvent } = await import('@renderer/lib/analytics');
      trackEvent('');

      expect(mockGtag).toHaveBeenCalledWith('event', '', undefined);
    });

    it('should handle empty page path', async () => {
      (globalThis as unknown as { window: { gtag: typeof mockGtag } }).window = { gtag: mockGtag };

      const { trackPageView } = await import('@renderer/lib/analytics');
      trackPageView('');

      expect(mockGtag).toHaveBeenCalledWith('config', 'G-RQWHYJ5NEG', {
        page_path: '',
        page_title: undefined,
      });
    });
  });
});
