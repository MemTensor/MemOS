import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "qwen-code",
  "agentId": "qwen-code",
  "name": "Qwen Code",
  "kind": "hook",
  "command": "qwen",
  "versions": [
    "0.27.4"
  ],
  "skillPath": ".qwen/skills",
  "retention": "history",
  "limitations": [],
  "configPath": ".qwen/settings.json"
};
