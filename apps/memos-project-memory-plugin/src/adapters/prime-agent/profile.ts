import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = { id: 'prime-agent', agentId: 'prime-agent', name: 'Prime Agent', kind: 'rpc', command: 'prime-agent', versions: ['0.10.5'], skillPath: '.prime/agent/skills', retention: 'history', limitations: ['原生终端通过 Skill 按需检索项目记忆；绑定项目后，后台核对原生结束状态并采集上传完整轮次。'] };
