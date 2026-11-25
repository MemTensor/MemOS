import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "workbuddy",
  "agentId": "workbuddy",
  "name": "WorkBuddy desktop",
  "kind": "hook",
  "command": "workbuddy",
  "versions": ["5.3.14"],
  "configPath": ".workbuddy/settings.json",
  "skillPath": ".workbuddy/skills",
  "retention": "history",
  "limitations": ["当前接入适用于 WorkBuddy macOS 桌面版。"]
};
