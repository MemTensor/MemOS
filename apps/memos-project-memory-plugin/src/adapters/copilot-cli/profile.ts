import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "copilot-cli",
  "agentId": "copilot-cli",
  "name": "GitHub Copilot CLI",
  "kind": "hook",
  "command": "copilot",
  "versions": [
    "1.0.112"
  ],
  "skillPath": ".copilot/skills",
  "retention": "history",
  "limitations": ["部分版本可能无法自动注入项目记忆；遇到该情况时，可让 Agent 使用项目记忆 Skill 主动检索。"],
  "configPath": ".copilot/hooks/memos-project-memory.json"
};
