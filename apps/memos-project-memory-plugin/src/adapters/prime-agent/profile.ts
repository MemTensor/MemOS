import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = { id: 'prime-agent', agentId: 'prime-agent', name: 'Prime Agent', kind: 'rpc', command: 'prime-agent', versions: ['0.10.3'], skillPath: '.prime/agent/skills', retention: 'history', limitations: ["需要通过 MemOS 提供的专用启动入口发送消息；直接打开原有交互界面不会启用项目记忆。"] };
