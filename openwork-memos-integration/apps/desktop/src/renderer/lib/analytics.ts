// Google Analytics tracking utilities
// GA Measurement ID: G-RQWHYJ5NEG

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

const GA_MEASUREMENT_ID = 'G-RQWHYJ5NEG';

/**
 * Track a page view
 */
export function trackPageView(pagePath: string, pageTitle?: string): void {
  if (typeof window.gtag !== 'function') return;

  window.gtag('config', GA_MEASUREMENT_ID, {
    page_path: pagePath,
    page_title: pageTitle,
  });
}

/**
 * Track a custom event
 */
export function trackEvent(
  eventName: string,
  params?: Record<string, string | number | boolean>
): void {
  if (typeof window.gtag !== 'function') return;

  window.gtag('event', eventName, params);
}

// Pre-defined event trackers for common actions
export const analytics = {
  // Track when user submits a task
  trackSubmitTask: () => {
    trackEvent('submit_task', {
      event_category: 'engagement',
      event_label: 'task_submission',
    });
  },

  // Track when user clicks New Task button
  trackNewTask: () => {
    trackEvent('new_task', {
      event_category: 'engagement',
      event_label: 'new_task_click',
    });
  },

  // Track when user opens settings
  trackOpenSettings: () => {
    trackEvent('open_settings', {
      event_category: 'engagement',
      event_label: 'settings_click',
    });
  },

  // Track when user saves an API key (does NOT include the key itself)
  trackSaveApiKey: (provider: string) => {
    trackEvent('save_api_key', {
      event_category: 'settings',
      event_label: 'api_key_save',
      provider,
    });
  },

  // Track when user selects a provider type
  trackSelectProvider: (provider: string) => {
    trackEvent('select_provider', {
      event_category: 'settings',
      event_label: 'provider_selection',
      provider,
    });
  },

  // Track when user selects a model
  trackSelectModel: (model: string) => {
    trackEvent('select_model', {
      event_category: 'settings',
      event_label: 'model_selection',
      model,
    });
  },

  // Track when user toggles debug mode
  trackToggleDebugMode: (enabled: boolean) => {
    trackEvent('toggle_debug_mode', {
      event_category: 'settings',
      event_label: 'debug_mode_toggle',
      enabled,
    });
  },

  // Track page views
  trackPageView,

  // Generic event tracking
  trackEvent,
};

export default analytics;
