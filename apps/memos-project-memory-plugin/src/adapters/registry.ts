import { profile as p0 } from './claude-code/profile.ts';
import { profile as p1 } from './codex-cli/profile.ts';
import { profile as p2 } from './cursor-cli/profile.ts';
import { profile as p3 } from './copilot-cli/profile.ts';
import { profile as p4 } from './grok-build/profile.ts';
import { profile as p5 } from './qwen-code/profile.ts';
import { profile as p6 } from './kimi-code/profile.ts';
import { profile as p7 } from './factory-droid/profile.ts';
import { profile as p8 } from './zcode/profile.ts';
import { profile as p9 } from './trae/profile.ts';
import { profile as p10 } from './antigravity-cli/profile.ts';
import { profile as p11 } from './devin-cli/profile.ts';
import { profile as p12 } from './deepagents-dcode/profile.ts';
import { profile as p13 } from './workbuddy/profile.ts';
import { profile as p14 } from './codebuddy-cli/profile.ts';
import { profile as p15 } from './opencode-v1/profile.ts';
import { profile as p16 } from './opencode-v2/profile.ts';
import { profile as p17 } from './kilo-cli/profile.ts';
import { profile as p18 } from './cline-cli/profile.ts';
import { profile as p19 } from './pi/profile.ts';
import { profile as p20 } from './prime-agent/profile.ts';
import { profile as p21 } from './deepseek-harness/profile.ts';
export const profiles = [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15, p16, p17, p18, p19, p20, p21];
export function getProfile(id: string) {
 const profile=profiles.find(item=>item.id===id);
 if (!profile) throw new Error(`Unknown adapter: ${id}`);
 return profile;
}
