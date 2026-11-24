import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "deepagents-dcode",
  "agentId": "deepagents-dcode",
  "name": "Deep Agents Code",
  "kind": "hook",
  "command": "dcode",
  "versions": [
    "0.2.8"
  ],
  "skillPath": ".agents/skills",
  "retention": "history",
  "limitations": [],
  "configPath": ".deepagents/hooks.json"
};
