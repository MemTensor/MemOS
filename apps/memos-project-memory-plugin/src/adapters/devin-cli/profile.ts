import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "devin-cli",
  "agentId": "devin-cli",
  "name": "Devin CLI",
  "kind": "hook",
  "command": "devin",
  "versions": [
    "3000.12.57"
  ],
  "skillPath": ".config/devin/skills",
  "retention": "history",
  "limitations": ["仅保存宿主提供的会话记录，可能无法获取完整的 Agent 回复。"],
  "configPath": ".config/devin/config.json"
};
