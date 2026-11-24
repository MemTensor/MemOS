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
  "limitations": ["对话创建 Space 需要 PreInvocation 提供原生 turn_id，或精确 transcriptPath 中存在可验证的用户记录 ID；缺少来源时不推测当前轮。"],
  "configPath": ".gemini/config/hooks.json"
};
