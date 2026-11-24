import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "trae",
  "agentId": "trae",
  "name": "TRAE CN desktop",
  "kind": "hook",
  "command": "trae",
  "versions": [],
  "skillPath": ".trae-cn/skills",
  "retention": "history",
  "limitations": ["当前接入适用于 TRAE 国内桌面版，不适用于 TRAE CLI。", "仅保存宿主提供的会话记录，可能无法获取完整对话。"],
  "configPath": ".trae-cn/hooks.json"
};
