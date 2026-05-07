/**
 * Bundled MemOS memory-guide skill content.
 * Reads from skill/memos-memory-guide/SKILL.md at runtime (single source of truth).
 */
import * as fs from "fs";
import * as path from "path";

const skillPath = path.join(__dirname, "..", "..", "skill", "memos-memory-guide", "SKILL.md");
export const MEMORY_GUIDE_SKILL_MD: string = fs.readFileSync(skillPath, "utf-8");
