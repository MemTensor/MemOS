/**
 * LLM-assisted feedback refiner.
 *
 * Transforms raw user feedback into actionable guidance, following the same
 * structure as L2 induction (title, trigger, procedure, verification, caveats).
 *
 * This ensures consistency between feedback-derived experiences and L2-induced
 * policies, making them interchangeable in retrieval and injection.
 */

import type { LlmClient } from "../llm/index.js";
import type { TraceRow } from "../types.js";
import { rootLogger } from "../logger/index.js";
import { sanitizeDerivedText, sanitizeDerivedMarkdown, sanitizeDerivedMarkdownList } from "../safety/content.js";

const log = rootLogger.child({ channel: "core.experience.refiner" });

export interface RefinedGuidance {
  /** Short, actionable title (e.g., "确认排序方向需求"). */
  title: string;
  /** When to apply this guidance (trigger condition). */
  trigger: string;
  /** What to do (actionable procedure). */
  procedure: string;
  /** What to avoid (anti-pattern). */
  caveats: string[];
  /** How to verify correctness. */
  verification: string;
  /** Confidence in this refinement (0-1). */
  confidence: number;
  /** Refinement method: "llm" or "rule". */
  method: "llm" | "rule";
}

export interface RefineInput {
  /** Raw user feedback text. */
  feedbackText: string;
  /** User's original request (last turn). */
  userRequest?: string;
  /** Agent's response that triggered the feedback (last turn). */
  agentResponse?: string;
  /** Full episode context (first turn + last 3 turns). */
  episodeContext?: string;
  /** Feedback polarity: positive, negative, neutral. */
  polarity: "positive" | "negative" | "neutral";
  /** Trace context (optional). */
  trace?: TraceRow | null;
}

export interface FeedbackRefinerOptions {
  llm?: LlmClient;
  timeoutMs?: number;
  disableLlm?: boolean;
}

export interface FeedbackRefiner {
  refine(input: RefineInput): Promise<RefinedGuidance>;
}

export function createFeedbackRefiner(
  opts: FeedbackRefinerOptions = {},
): FeedbackRefiner {
  const llmDisabled = opts.disableLlm ?? !opts.llm;
  const llm = opts.llm;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  return {
    async refine(input: RefineInput): Promise<RefinedGuidance> {
      // Try LLM refinement first
      if (!llmDisabled && llm && input.userRequest && input.agentResponse) {
        try {
          const result = await withTimeout(
            refineByLlm(llm, input),
            timeoutMs,
          );
          log.debug("llm.ok", {
            title: result.title,
            confidence: result.confidence,
          });
          return result;
        } catch (err) {
          log.warn("llm.failed", {
            err: err instanceof Error ? err.message : String(err),
          });
          // Fall through to rule-based fallback
        }
      }

      // Fallback to rule-based extraction
      return refineByRules(input);
    },
  };
}

// ─── LLM-based refinement ───────────────────────────────────────────────────

async function refineByLlm(
  llm: LlmClient,
  input: RefineInput,
): Promise<RefinedGuidance> {
  const prompt = buildRefinementPrompt(input);

  const response = await llm.completeJson<{
    title: unknown;
    trigger: unknown;
    procedure: unknown;
    caveats?: unknown;
    verification?: unknown;
    confidence?: unknown;
  }>(
    [
      { role: "system", content: FEEDBACK_REFINEMENT_SYSTEM },
      { role: "user", content: prompt },
    ],
    {
      temperature: 0.2,
      maxTokens: 500,
      op: "feedback.refine",
    },
  );

  return normalizeDraft(response.value, input);
}

const FEEDBACK_REFINEMENT_SYSTEM = `You extract actionable guidance from user feedback.

Given a user's feedback on an agent's response, produce a **procedural policy**
that helps the agent avoid the same mistake (or replicate the same success) in
future similar tasks.

CRITICAL REQUIREMENTS:

1. **TRIGGER must be SPECIFIC and CONCRETE**:
   - ❌ BAD: "当遇到类似任务时" (too vague, no information)
   - ❌ BAD: "When a similar task appears" (what is "similar"?)
   - ✅ GOOD: "当用户要求实现排序算法时" (specific task type)
   - ✅ GOOD: "当用户要求实现冒泡排序时" (even more specific)

   Extract the CONCRETE TASK TYPE from the episode context:
   - What is the user asking for? (e.g., "冒泡排序", "数据筛选", "API调用")
   - What domain? (e.g., "算法实现", "数据处理", "文件操作")
   - What specific feature? (e.g., "排序方向", "筛选条件", "错误处理")

2. **PROCEDURE must be ACTIONABLE and CONCISE**:
   - ❌ BAD: "根据反馈调整" (no specific action)
   - ❌ BAD: "采用替代方案" (what alternative?)
   - ✅ GOOD: "实现从大到小的排序"
   - ✅ GOOD: "明确询问用户排序方向（升序/降序）"

   Specify CONCRETE STEPS the agent should take. Keep it concise.

3. **CAVEATS must provide SPECIFIC ANTI-PATTERNS** (optional):
   - ❌ BAD: "避免重复当前的错误" (no information gain)
   - ❌ BAD: "避免当前的做法" (what approach?)
   - ✅ GOOD: "不要假设默认排序方向为升序"
   - ✅ GOOD: "不要在未确认需求时使用 AND 逻辑"
   - ✅ EMPTY: [] (if no specific anti-pattern can be extracted)

   Extract the SPECIFIC MISTAKE from the feedback. If none, leave empty.

4. **VERIFICATION is OPTIONAL**:
   - ❌ BAD: "检查是否解决了用户指出的问题" (circular, no information)
   - ✅ GOOD: "检查生成的代码中比较运算符方向（< vs >）"
   - ✅ EMPTY: "" (if no specific verification method exists)

   Only provide verification if there's a CONCRETE, CHECKABLE method.
   If you can't think of a specific verification step, leave it EMPTY.

IMPORTANT: Focus on TRIGGER + PROCEDURE. These are the core fields.
Caveats and verification are optional - only fill them if you have specific content.

Return JSON:
{
  "title": "short imperative title",
  "trigger": "SPECIFIC task type/domain/feature (NOT '类似任务')",
  "procedure": "CONCRETE actionable steps (NOT '根据反馈调整')",
  "caveats": ["SPECIFIC anti-patterns"] or [],
  "verification": "CHECKABLE verification method" or "",
  "confidence": number in [0, 1]
}`;

function buildRefinementPrompt(input: RefineInput): string {
  const isNegative = input.polarity === "negative";

  // Use full episode context if available, otherwise fall back to single turn
  let contextSection: string;
  if (input.episodeContext) {
    contextSection = `EPISODE CONTEXT (first turn + last 3 turns):
${input.episodeContext}`;
  } else {
    const userRequest = truncate(input.userRequest ?? "", 500);
    const agentResponse = truncate(input.agentResponse ?? "", 800);
    contextSection = `USER REQUEST:
${userRequest}

AGENT RESPONSE:
${agentResponse}`;
  }

  return `${contextSection}

USER FEEDBACK (${input.polarity}):
${input.feedbackText}

${isNegative ? `
Extract guidance to AVOID this mistake.

CRITICAL: Be SPECIFIC and CONCISE!
- Identify the CONCRETE task type (e.g., "实现冒泡排序", not "类似任务")
- Extract the SPECIFIC requirement (e.g., "从大到小", not "根据反馈调整")
- Only fill caveats/verification if you have SPECIFIC content

Example 1 (Simple - just trigger + procedure):
Turn 1:
User: "写个冒泡排序"
Agent: [generates ascending sort code]

Turn 2:
User: "写的不对，我要的是从大到小的"

Output:
{
  "title": "冒泡排序：从大到小",
  "trigger": "当用户要求实现冒泡排序时",
  "procedure": "实现从大到小的排序（使用 > 比较运算符）",
  "caveats": [],
  "verification": "",
  "confidence": 0.85
}

Example 2 (With caveats and verification):
Turn 1:
User: "写个函数筛选数组中的偶数"
Agent: [generates filter with wrong logic]

Turn 2:
User: "不对，应该用 AND 条件，不是 OR"

Output:
{
  "title": "确认筛选条件的逻辑运算符",
  "trigger": "当用户要求筛选或过滤数据时",
  "procedure": "在生成代码前，明确询问用户筛选条件之间的逻辑关系（AND/OR）",
  "caveats": ["不要假设多个条件默认使用 OR 逻辑"],
  "verification": "检查生成的代码中逻辑运算符（&& vs ||）是否符合用户要求",
  "confidence": 0.9
}

BAD Example (too generic):
{
  "title": "修正用户反馈",
  "trigger": "当遇到类似任务时",  ← ❌ What is "similar"?
  "procedure": "根据反馈调整",  ← ❌ No actionable steps
  "caveats": ["避免重复当前的错误"],  ← ❌ No information gain
  "verification": "检查是否解决了问题",  ← ❌ Circular
  "confidence": 0.5
}
` : `
Extract guidance to REPLICATE this success.

CRITICAL: Be SPECIFIC and CONCISE!
- Identify the CONCRETE task type
- Extract the SPECIFIC success pattern
- Only fill caveats/verification if you have SPECIFIC content

Example:
Turn 1:
User: "写个快速排序"
Agent: [generates quicksort with three-way partitioning]

Turn 2:
User: "很好，这个实现很高效"

Output:
{
  "title": "快速排序：使用三路划分优化",
  "trigger": "当用户要求实现快速排序算法时",
  "procedure": "使用三路划分（three-way partitioning）处理重复元素，选择中位数或随机元素作为 pivot",
  "caveats": ["避免简单选择首元素作为 pivot，在已排序数组上会退化到 O(n²)"],
  "verification": "检查代码是否包含三路划分逻辑（小于、等于、大于三个分区）",
  "confidence": 0.85
}
`}

Output JSON:`;
}

function normalizeDraft(
  value: Record<string, unknown>,
  input: RefineInput,
): RefinedGuidance {
  const caveats = Array.isArray(value.caveats)
    ? sanitizeDerivedMarkdownList((value.caveats as unknown[]).filter((c): c is string => typeof c === "string"))
    : [];
  const confidence = typeof value.confidence === "number" ? clamp(value.confidence, 0, 1) : 0.7;

  // Allow empty verification
  const verification = value.verification && typeof value.verification === "string"
    ? sanitizeDerivedMarkdown(value.verification).slice(0, 300)
    : "";

  return {
    title: sanitizeDerivedText(value.title).slice(0, 120),
    trigger: sanitizeDerivedMarkdown(value.trigger).slice(0, 300),
    procedure: sanitizeDerivedMarkdown(value.procedure).slice(0, 400),
    caveats,
    verification,
    confidence,
    method: "llm",
  };
}

// ─── Rule-based refinement ──────────────────────────────────────────────────

function refineByRules(input: RefineInput): RefinedGuidance {
  const text = input.feedbackText;
  const lower = text.toLowerCase();
  const isNegative = input.polarity === "negative";

  // Try to extract task context from episode or trace
  const taskContext = extractTaskContext(input);

  // Extract preference patterns: "用X代替Y" / "用X而不是Y"
  const preferMatch = text.match(/用\s*(.+?)\s*(代替|而不是|instead of)\s*(.+?)([。!?\n]|$)/i);
  if (preferMatch) {
    const prefer = preferMatch[1]?.trim();
    const avoid = preferMatch[3]?.trim();
    return {
      title: `偏好：使用 ${prefer}`,
      trigger: taskContext.trigger || `当需要选择实现方式时`,
      procedure: `使用 ${prefer} 而不是 ${avoid}`,
      caveats: [`避免使用 ${avoid}`],
      verification: `检查实现是否使用了 ${prefer}`,
      confidence: 0.75,
      method: "rule",
    };
  }

  // Extract "should" patterns: "应该..."
  const shouldMatch = text.match(/应该|should\s+(.+?)([。!?\n]|$)/i);
  if (shouldMatch) {
    const action = shouldMatch[1]?.trim() || text;
    return {
      title: isNegative ? `修正：${firstSentence(action, 60)}` : `建议：${firstSentence(action, 60)}`,
      trigger: taskContext.trigger || `当处理相关需求时`,
      procedure: action,
      caveats: isNegative ? [`避免忽略：${action}`] : [],
      verification: `检查是否执行了：${firstSentence(action, 80)}`,
      confidence: 0.65,
      method: "rule",
    };
  }

  // Extract "avoid" patterns: "不要..." / "别..."
  const avoidMatch = text.match(/(不要|别|avoid|don't)\s+(.+?)([。!?\n]|$)/i);
  if (avoidMatch) {
    const antiPattern = avoidMatch[2]?.trim() || text;
    return {
      title: `避坑：${firstSentence(antiPattern, 60)}`,
      trigger: taskContext.trigger || `当处理相关需求时`,
      procedure: `注意避免：${antiPattern}`,
      caveats: [antiPattern],
      verification: `检查是否避免了：${firstSentence(antiPattern, 80)}`,
      confidence: 0.7,
      method: "rule",
    };
  }

  // Extract correction patterns: "不对" / "错了" / "wrong"
  const correctionMatch = text.match(/(不对|错了|不是|wrong|incorrect)[，,、]?\s*(.+?)([。!?\n]|$)/i);
  if (correctionMatch && isNegative) {
    const correction = correctionMatch[2]?.trim();
    if (correction && correction.length > 3) {
      return {
        title: `修正：${firstSentence(correction, 60)}`,
        trigger: taskContext.trigger || taskContext.taskType || `当处理类似需求时`,
        procedure: correction,
        caveats: [],
        verification: "",
        confidence: 0.6,
        method: "rule",
      };
    }
  }

  // Generic negative feedback (last resort)
  if (isNegative) {
    return {
      title: `修正：${firstSentence(text, 80)}`,
      trigger: taskContext.trigger || taskContext.taskType || `当处理相关需求时`,
      procedure: text,
      caveats: [],
      verification: "",
      confidence: 0.5,
      method: "rule",
    };
  }

  // Generic positive feedback
  return {
    title: `成功模式：${firstSentence(text, 80)}`,
    trigger: taskContext.trigger || taskContext.taskType || `当处理相关需求时`,
    procedure: `继续使用这种方法：${text}`,
    caveats: [],
    verification: "",
    confidence: 0.6,
    method: "rule",
  };
}

/**
 * Extract task context from episode/trace to make trigger more specific.
 */
function extractTaskContext(input: RefineInput): { trigger: string; taskType: string } {
  const userRequest = input.userRequest || "";
  const episodeContext = input.episodeContext || "";
  const combined = `${userRequest} ${episodeContext}`.toLowerCase();

  // Extract task type keywords
  const taskPatterns = [
    { pattern: /(写|实现|生成|创建).{0,5}(排序|冒泡|快排|归并|选择|插入)/, trigger: "当用户要求实现排序算法时", type: "排序算法实现" },
    { pattern: /(写|实现|生成|创建).{0,5}(搜索|查找|二分|遍历)/, trigger: "当用户要求实现搜索算法时", type: "搜索算法实现" },
    { pattern: /(写|实现|生成|创建).{0,5}(递归|迭代|循环)/, trigger: "当用户要求实现递归或迭代逻辑时", type: "递归/迭代实现" },
    { pattern: /(筛选|过滤|filter|select).{0,10}(数据|数组|列表)/, trigger: "当用户要求筛选或过滤数据时", type: "数据筛选" },
    { pattern: /(读取|写入|操作).{0,5}(文件|file)/, trigger: "当用户要求进行文件操作时", type: "文件操作" },
    { pattern: /(调用|请求|fetch).{0,5}(api|接口|服务)/, trigger: "当用户要求调用API或服务时", type: "API调用" },
    { pattern: /(处理|解析|parse).{0,5}(json|xml|数据)/, trigger: "当用户要求解析数据时", type: "数据解析" },
    { pattern: /(格式化|format|转换)/, trigger: "当用户要求格式化或转换数据时", type: "数据格式化" },
  ];

  for (const { pattern, trigger, type } of taskPatterns) {
    if (pattern.test(combined)) {
      return { trigger, taskType: type };
    }
  }

  // Fallback: try to extract verb + noun
  const verbNounMatch = combined.match(/(写|实现|生成|创建|处理|操作)\s*(.{2,10}?)(算法|功能|代码|逻辑|数据)?/);
  if (verbNounMatch) {
    const verb = verbNounMatch[1];
    const noun = verbNounMatch[2]?.trim();
    if (noun && noun.length > 1) {
      return {
        trigger: `当用户要求${verb}${noun}时`,
        taskType: `${noun}${verb}`,
      };
    }
  }

  return { trigger: "", taskType: "" };
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function firstSentence(text: string, maxChars: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const sentence = trimmed.split(/(?<=[.!?。！？])\s+/)[0] ?? trimmed;
  const cleaned = sentence.replace(/^["'`]|["'`]$/g, "").trim();
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, Math.max(0, maxChars - 3))}...`;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms),
    ),
  ]);
}
