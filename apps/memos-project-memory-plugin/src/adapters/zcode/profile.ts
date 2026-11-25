import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "zcode",
  "agentId": "zcode",
  "name": "ZCode",
  "kind": "hook",
  "command": "zcode",
  "versions": [
    "3.18.2"
  ],
  "skillPath": ".zcode/skills",
  "retention": "history",
  "limitations": ["请使用 ZCode 桌面版接入。"],
  "configPath": ".zcode/cli/config.json"
};
