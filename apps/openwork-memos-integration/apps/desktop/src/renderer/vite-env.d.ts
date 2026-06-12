/// <reference types="vite/client" />

import type { AccomplishAPI } from './lib/accomplish';

declare global {
  interface Window {
    accomplish: AccomplishAPI;
    accomplishShell?: {
      version: string;
      platform: string;
      isElectron: boolean;
    };
  }
}

export {};
