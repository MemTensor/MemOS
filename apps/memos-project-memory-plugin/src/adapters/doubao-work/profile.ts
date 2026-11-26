import type { AdapterProfile } from '../types.ts';

export const profile: AdapterProfile = {
  id: 'doubao-work', agentId: 'doubao-work', name: '豆包工作', kind: 'native-skill',
  command: 'DoubaoWork', versions: ['2.38.3'], skillPath: 'DoubaoWork/skills', retention: 'history',
  limitations: ['macOS 版通过本机工具运行查询 Skill。请在 Viewer 中绑定项目与 Space。'],
};
