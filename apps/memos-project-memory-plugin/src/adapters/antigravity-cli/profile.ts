import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "antigravity-cli",
  "agentId": "antigravity-cli",
  "name": "Antigravity CLI",
  "kind": "hook",
  "command": "agy",
  "versions": [
    "1.5.7"
  ],
  "skillPath": ".gemini/config/skills",
  "retention": "history",
  "limitations": [],
  "configPath": ".gemini/config/hooks.json"
};
