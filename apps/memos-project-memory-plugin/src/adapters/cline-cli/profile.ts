import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = { id: 'cline-cli', agentId: 'cline-cli', name: 'Cline CLI', kind: 'extension', command: 'cline', versions: ['3.0.74'], skillPath: '.cline/skills', retention: 'history', limitations: ["当前接入用于单会话 CLI，不适用于多会话 Hub。"] };
