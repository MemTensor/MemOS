import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "grok-build",
  "agentId": "grok-build",
  "name": "Grok Build",
  "kind": "hook",
  "command": "grok",
  "versions": [
    "1.0.77"
  ],
  "skillPath": ".grok/skills",
  "retention": "history",
  "limitations": ["首条模型请求不会自动附带项目概览；可让 Agent 使用项目记忆 Skill 主动检索。"],
  "configPath": ".grok/hooks/memos-project-memory.json"
};
