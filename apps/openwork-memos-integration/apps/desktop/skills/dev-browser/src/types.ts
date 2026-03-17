// API request/response types - shared between client and server

export interface ServeOptions {
  port?: number;
  headless?: boolean;
  cdpPort?: number;
  /** Directory to store persistent browser profiles (cookies, localStorage, etc.) */
  profileDir?: string;
  /** Try to use system Chrome first before falling back to Playwright Chromium */
  useSystemChrome?: boolean;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface GetPageRequest {
  name: string;
  /** Optional viewport size for new pages */
  viewport?: ViewportSize;
}

export interface GetPageResponse {
  wsEndpoint: string;
  name: string;
  targetId: string; // CDP target ID for reliable page matching
}

export interface ListPagesResponse {
  pages: string[];
}

export interface ServerInfoResponse {
  wsEndpoint: string;
}
