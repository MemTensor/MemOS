/**
 * Type declarations for openclaw/plugin-sdk
 * This module is provided by the OpenClaw runtime environment
 */

export interface OpenClawPluginApi {
  registerTool(tool: any, options?: any): void;
  [key: string]: any;
}

export const plugin: OpenClawPluginApi;
