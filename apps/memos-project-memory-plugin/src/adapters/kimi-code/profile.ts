import type { AdapterProfile } from '../types.ts';
export const profile: AdapterProfile = {
  "id": "kimi-code",
  "agentId": "kimi-code",
  "name": "Kimi Code",
  "kind": "hook",
  "command": "kimi",
  "versions": [
    "2.6.2"
  ],
  "skillPath": ".kimi-code/skills",
  "retention": "history",
  "limitations": ["当前接入适用于新版 Kimi Code。本地服务需要与 Agent 在同一台机器运行，暂不支持直接接入远程运行的 Agent。"],
  "configPath": ".kimi-code/config.toml"
};
