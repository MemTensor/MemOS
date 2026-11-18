import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "codex-cli",
  "agentId": "codex-cli",
  "name": "Codex CLI",
  "kind": "hook",
  "command": "codex",
  "versions": [
    "0.149.0"
  ],
  "skillPath": ".agents/skills",
  "retention": "history",
  "limitations": ["安装后，在 Codex 中打开 /hooks，按提示信任并启用 MemOS 的 Hook，才能采集会话和提供项目记忆。"],
  "configPath": ".codex/hooks.json"
};
