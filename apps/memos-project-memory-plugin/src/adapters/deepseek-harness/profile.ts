import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = { id: 'deepseek-harness', agentId: 'deepseek-harness', name: 'DeepSeek Harness', kind: 'extension', command: 'dsh', versions: ['0.2.2-rc.3'], skillPath: '.dsh/skills', retention: 'history', limitations: [] };
