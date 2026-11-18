import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "codebuddy-cli",
  "agentId": "codebuddy-cli",
  "name": "CodeBuddy Code CLI",
  "kind": "hook",
  "command": "codebuddy",
  "versions": [
    "2.184.0"
  ],
  "skillPath": ".codebuddy/skills",
  "retention": "history",
  "limitations": ["Windows 用户需要先安装 Git Bash，才能运行接入命令。"],
  "configPath": ".codebuddy/settings.json"
};
