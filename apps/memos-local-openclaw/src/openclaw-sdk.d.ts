declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    registerTool(...args: any[]): void;
    registerHook(...args: any[]): void;
    registerMemoryCapability(...args: any[]): void;
    registerService(...args: any[]): void;
    getConfig(): any;
    getLogger(): any;
    config: any;
    logger: any;
    [key: string]: any;
  }
}
