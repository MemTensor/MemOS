import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "claude-code",
  "agentId": "claude-code",
  "name": "Claude Code",
  "kind": "hook",
  "command": "claude",
  "versions": [
    "2.1.325"
  ],
  "skillPath": ".claude/skills",
  "retention": "history",
  "sessionStartBlocking": true,
  "limitations": [],
  "configPath": ".claude/settings.json"
};
