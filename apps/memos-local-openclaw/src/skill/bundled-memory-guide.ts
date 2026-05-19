/**
 * Bundled MemOS memory-guide skill content.
 * Reads from skill/memos-memory-guide/SKILL.md at runtime (single source of truth).
 */
import * as fs from "fs";
import * as path from "path";
import { findPluginRoot } from "../shared/plugin-root";

const skillPath = path.join(findPluginRoot(import.meta.url), "skill", "memos-memory-guide", "SKILL.md");
export const MEMORY_GUIDE_SKILL_MD: string = fs.readFileSync(skillPath, "utf-8");
