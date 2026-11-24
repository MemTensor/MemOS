import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = { id: 'opencode-v1', agentId: 'opencode-v1', name: 'OpenCode v1', kind: 'extension', command: 'opencode', versions: ['1.19.5'], skillPath: '.config/opencode/skills', retention: 'request-view', limitations: ["请选择与本机 OpenCode 主版本一致的接入；v1 与 v2 不能同时启用。"] };
