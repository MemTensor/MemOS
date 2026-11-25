import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "cursor-cli",
  "agentId": "cursor-cli",
  "name": "Cursor CLI",
  "kind": "hook",
  "command": "agent",
  "versions": [
    "2026.10.22"
  ],
  "skillPath": ".cursor/skills",
  "retention": "history",
  "limitations": ["请在 Cursor 中开启会话记录（transcripts），否则无法读取完整对话。", "项目记忆在会话启动时加载，首条请求可能无法及时获得项目概览。"],
  "configPath": ".cursor/hooks.json"
};
