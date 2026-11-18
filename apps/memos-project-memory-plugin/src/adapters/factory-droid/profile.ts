import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "factory-droid",
  "agentId": "factory-droid",
  "name": "Factory Droid",
  "kind": "hook",
  "command": "droid",
  "versions": [
    "1.12.0"
  ],
  "skillPath": ".factory/skills",
  "retention": "history",
  "limitations": [],
  "configPath": ".factory/hooks.json"
};
