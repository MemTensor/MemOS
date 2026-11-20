import type { RetrievalProfile } from "./types.js";

const PERSONAL_FACT_MARKERS =
  /(?:喜欢|最爱|爱吃|爱喝|爱听|偏好|讨厌|不喜欢|名字|姓名|生日|家乡|住在|职业|工作|宠物|歌手|水果|食物|颜色|称呼)/u;
const FIRST_PERSON_MARKERS = /(?:我|我的|本人|关于我)/u;
const PROCEDURAL_MARKERS =
  /(?:怎么|如何|怎样).*(?:修|解决|处理|配置|安装|实现|排查)|(?:修复|解决|排查).*(?:问题|故障|报错)/u;
const ENGLISH_PERSONAL_FACT =
  /\b(?:what|who|where|when).*\b(?:my|i)\b.*\b(?:favorite|like|love|prefer|name|birthday|live|job|pet)\b|\b(?:my favorite|what do i like|what i like)\b/i;

/**
 * Conservative, deterministic routing for query-specific retrieval policy.
 *
 * Only high-confidence first-person facts are specialised. Everything else
 * stays on the legacy/default route so troubleshooting and task recall do not
 * accidentally lose Tier-1 skills.
 */
export function classifyRetrievalProfile(userText: string): RetrievalProfile {
  const text = userText.trim();
  if (!text || PROCEDURAL_MARKERS.test(text)) return "default";
  if (
    (FIRST_PERSON_MARKERS.test(text) && PERSONAL_FACT_MARKERS.test(text)) ||
    ENGLISH_PERSONAL_FACT.test(text)
  ) {
    return "personal_fact";
  }
  return "default";
}
