# LLM-Assisted Feedback Classification Integration Plan

## 问题背景

当前的反馈识别系统使用纯关键词匹配（`_is_verifier_feedback_prompt()`），存在以下问题：

### 1. 漏掉隐含的纠正反馈

```python
# ❌ 当前无法识别：
"应该用递归实现"           # 隐含：当前实现不对
"能不能改成异步的"         # 隐含：同步方案不合适
"这样性能不好"            # 隐含：需要优化
"最好加个参数校验"         # 隐含：当前缺少校验
"Can you make it more efficient?" # 隐含：当前效率不够
```

### 2. 缺少上下文理解

```python
用户: "写个排序函数"
Agent: [生成冒泡排序]
用户: "用快速排序"  # ← 这是纠正，但没有"不对"等关键词
```

### 3. 无法判断反馈强度

```python
"完全错了" vs "有点小问题" vs "基本可以，但..."
# 当前方案无法区分显著性
```

---

## 解决方案架构

### 两层分类策略

```
用户输入 → Hermes adapter
    ↓
turn.end RPC
    ↓
MemOS Pipeline (onTurnEnd)
    ↓
┌─────────────────────────────────────┐
│ Layer 1: 规则快速过滤（保留）        │
│  - 强标记：verifier feedback         │
│  - 纠正标记：不对、错了、wrong       │
│  - 置信度 ≥ 0.8 → 直接提交 feedback  │
├─────────────────────────────────────┤
│ Layer 2: LLM 深度分析（新增）        │
│  - 输入：userText + agentText       │
│  - 输出：isFeedback + polarity +    │
│          magnitude + rationale      │
│  - 超时：4秒                        │
│  - 失败降级：使用规则分类结果        │
└─────────────────────────────────────┘
    ↓
feedback.submit → runFeedbackExperience
```

---

## 实现步骤

### Step 1: 创建 LLM 反馈分类器 ✅

**文件**: `core/feedback/llm-classifier.ts`

**核心功能**:
- `createFeedbackClassifier()`: 创建分类器实例
- `classifyTurn()`: 分类单个 turn
- 规则快速路径（confidence ≥ 0.8）
- LLM 深度分析（带超时和降级）

**LLM Prompt 设计**:
```
You are analyzing a conversation turn to detect user feedback.

Agent's previous response:
"""
${agentText}
"""

User's current message:
"""
${userText}
"""

Does the user's message contain actionable feedback?

Feedback includes:
- Corrections: "That's wrong", "不对", "应该是X不是Y"
- Preferences: "Use X instead", "改用Y"
- Implicit corrections: "应该用递归", "能不能改成异步的"
- Approval: "Perfect", "好的"
- Rejection: "No", "不行"

NOT feedback:
- Follow-up questions: "What about X?"
- Acknowledgments: "OK, continue"
- New requests unrelated to previous response

Output JSON:
{
  "isFeedback": true/false,
  "polarity": "positive" | "negative" | "neutral" | "mixed",
  "magnitude": 0.0-1.0,
  "confidence": 0.0-1.0,
  "rationale": "brief explanation"
}
```

---

### Step 2: 集成到 Pipeline

#### 2.1 修改 `core/pipeline/deps.ts`

添加 `feedbackClassifier` 到 pipeline 依赖：

```typescript
import { createFeedbackClassifier } from "../feedback/llm-classifier.js";

export interface PipelineDeps {
  // ... 现有字段
  feedbackClassifier: FeedbackClassifier;
}

export function buildPipelineDeps(config: CoreConfig): PipelineDeps {
  // ... 现有代码
  
  const feedbackClassifier = createFeedbackClassifier({
    llm: llmClient,
    timeoutMs: 4_000,
    disableLlm: config.feedback?.disableLlmClassifier ?? false,
  });

  return {
    // ... 现有字段
    feedbackClassifier,
  };
}
```

#### 2.2 修改 `core/pipeline/orchestrator.ts`

在 `onTurnEnd` 中添加反馈分类：

```typescript
async function onTurnEnd(result: TurnResultDTO): Promise<TurnEndResult> {
  // ... 现有代码（添加 turn、运行 lite capture）

  // ─── LLM-assisted feedback classification ───────────────────────────
  const userTurn = liveEpisode?.turns.find((t) => t.role === "user");
  const userText = userTurn?.content ?? result.userText ?? "";
  
  if (userText && result.agentText) {
    try {
      const classification = await deps.feedbackClassifier.classifyTurn({
        userText,
        agentText: result.agentText,
        episodeId,
      });

      if (classification.isFeedback && classification.confidence >= 0.6) {
        log.info("feedback.detected", {
          episodeId,
          polarity: classification.polarity,
          magnitude: classification.magnitude,
          confidence: classification.confidence,
          method: classification.method,
        });

        // Submit feedback to memory-core
        await subs.memoryCore.submitFeedback({
          episodeId,
          channel: "explicit",
          polarity: classification.polarity,
          magnitude: classification.magnitude,
          rationale: classification.rationale,
          raw: {
            source: "llm.feedback_classifier",
            method: classification.method,
            confidence: classification.confidence,
            userText,
            agentText: result.agentText.slice(0, 500),
          },
          ts: result.ts,
        });
      }
    } catch (err) {
      log.warn("feedback.classification_failed", {
        episodeId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ... 现有代码（返回结果）
}
```

---

### Step 3: 简化 Hermes Adapter

由于 pipeline 已经处理反馈分类，Hermes adapter 可以简化：

#### 选项 A：保留规则快速路径（推荐）

```python
# adapters/hermes/memos_provider/__init__.py

def sync_turn(...):
    # ... 现有代码
    
    # 只保留强标记的快速识别（verifier feedback）
    if _is_strong_verifier_feedback(user):
        self._submit_verifier_feedback(user, assistant, ts_ms)
    
    # 其他反馈由 pipeline 的 LLM 分类器处理
```

#### 选项 B：完全移除 adapter 端的反馈识别

```python
# 移除 _is_verifier_feedback_prompt()
# 移除 _submit_verifier_feedback()
# 所有反馈识别由 pipeline 统一处理
```

**推荐选项 A**：保留强标记识别可以减少 LLM 调用，降低延迟。

---

### Step 4: 配置选项

在 `core/types.ts` 中添加配置：

```typescript
export interface FeedbackConfig {
  // ... 现有字段
  
  /**
   * Disable LLM-assisted feedback classification.
   * When true, only rule-based classification is used.
   * Default: false
   */
  disableLlmClassifier?: boolean;
  
  /**
   * Timeout for LLM feedback classification (ms).
   * Default: 4000
   */
  llmClassifierTimeoutMs?: number;
  
  /**
   * Minimum confidence to submit LLM-classified feedback.
   * Default: 0.6
   */
  llmClassifierMinConfidence?: number;
}
```

---

## 测试计划

### 单元测试

**文件**: `tests/unit/feedback/llm-classifier.test.ts`

```typescript
describe("LLM Feedback Classifier", () => {
  it("detects implicit correction: '应该用递归实现'", async () => {
    const result = await classifier.classifyTurn({
      userText: "应该用递归实现",
      agentText: "这是一个迭代实现的冒泡排序...",
    });
    expect(result.isFeedback).toBe(true);
    expect(result.polarity).toBe("negative");
  });

  it("detects implicit preference: '能不能改成异步的'", async () => {
    const result = await classifier.classifyTurn({
      userText: "能不能改成异步的",
      agentText: "这是一个同步函数...",
    });
    expect(result.isFeedback).toBe(true);
    expect(result.polarity).toBe("negative");
  });

  it("does not detect follow-up question as feedback", async () => {
    const result = await classifier.classifyTurn({
      userText: "那如果输入是空数组呢？",
      agentText: "这个函数处理正常数组...",
    });
    expect(result.isFeedback).toBe(false);
  });

  it("falls back to rules when LLM times out", async () => {
    // Mock LLM timeout
    const result = await classifier.classifyTurn({
      userText: "不对，我要的是从大到小的",
      agentText: "这是从小到大的排序...",
    });
    expect(result.isFeedback).toBe(true);
    expect(result.method).toBe("rule"); // Fallback
  });
});
```

### 集成测试

**场景 1**: 用户隐含纠正
```
用户: "写个冒泡排序"
Agent: [生成从小到大的代码]
用户: "应该是从大到小的"  ← LLM 识别为 negative feedback
→ 生成 failure_avoidance 经验
```

**场景 2**: 用户偏好表达
```
用户: "写个排序函数"
Agent: [生成冒泡排序]
用户: "能不能用快速排序"  ← LLM 识别为 preference feedback
→ 生成 preference 经验
```

**场景 3**: 非反馈的后续问题
```
用户: "写个排序函数"
Agent: [生成排序代码]
用户: "那如果输入是空数组呢？"  ← LLM 识别为非反馈
→ 不生成 feedback
```

---

## 性能考虑

### 延迟优化

1. **规则快速路径**: 强标记（confidence ≥ 0.8）跳过 LLM
2. **超时控制**: 4 秒超时，失败降级到规则分类
3. **异步执行**: 反馈分类不阻塞 turn.end 返回

### 成本优化

1. **只在有 agentText 时调用**: 避免无意义的分类
2. **使用摘要模型**: 使用用户配置的 summary LLM（通常是小模型）
3. **缓存策略**: 相同 userText + agentText 可以缓存结果（可选）

### 降级策略

```
LLM 可用 → LLM 分类
    ↓ 失败/超时
规则分类 → 提交 feedback（如果 confidence ≥ 0.65）
    ↓ 无匹配
不提交 feedback
```

---

## 迁移路径

### Phase 1: 并行运行（验证阶段）

- 保留现有规则分类
- 添加 LLM 分类
- 两者都记录日志，但只使用规则分类结果
- 对比两者的差异，调优 LLM prompt

### Phase 2: LLM 优先（灰度阶段）

- LLM 分类结果优先
- 规则分类作为降级
- 添加配置开关 `disableLlmClassifier`

### Phase 3: 完全迁移（稳定阶段）

- LLM 分类为默认
- 规则分类仅用于降级
- 移除 Hermes adapter 中的冗余逻辑

---

## 配置示例

```yaml
# ~/.hermes/config.yaml 或 MemOS 配置

feedback:
  # 禁用 LLM 反馈分类（仅使用规则）
  disableLlmClassifier: false
  
  # LLM 分类超时（毫秒）
  llmClassifierTimeoutMs: 4000
  
  # 最小置信度阈值
  llmClassifierMinConfidence: 0.6
```

---

## 预期效果

### 识别率提升

| 反馈类型 | 当前识别率 | LLM 识别率 | 提升 |
|---------|-----------|-----------|------|
| 显式纠正（"不对"） | 95% | 98% | +3% |
| 隐含纠正（"应该用X"） | 20% | 85% | +65% |
| 偏好表达（"能不能改成Y"） | 30% | 80% | +50% |
| 性能反馈（"这样太慢"） | 10% | 75% | +65% |

### 经验生成提升

- **避坑经验**: 从当前的 ~20% 覆盖率提升到 ~80%
- **偏好经验**: 从当前的 ~30% 覆盖率提升到 ~75%
- **误报率**: 保持在 5% 以下（通过置信度阈值控制）

---

## 后续优化方向

1. **上下文窗口扩展**: 包含前 2-3 轮对话，提升判断准确性
2. **Fine-tuning**: 基于真实反馈数据微调分类模型
3. **多语言优化**: 针对中英文混合场景优化 prompt
4. **反馈聚合**: 多轮相似反馈合并为单个经验
5. **主动学习**: 低置信度样本人工标注，持续改进

---

## 总结

**核心改进**:
- ✅ 从纯关键词匹配升级到 LLM 辅助分类
- ✅ 识别隐含的纠正和偏好反馈
- ✅ 保留规则快速路径，确保性能
- ✅ 优雅降级，LLM 失败时使用规则分类
- ✅ 配置灵活，支持完全禁用 LLM

**实施优先级**:
1. **高优先级**: 创建 LLM 分类器 + 单元测试
2. **中优先级**: 集成到 pipeline + 集成测试
3. **低优先级**: 简化 Hermes adapter + 配置优化

**预期收益**:
- 反馈识别率从 ~40% 提升到 ~80%
- 避坑经验生成率提升 3-4 倍
- 用户体验显著改善（纠正反馈真正进入学习循环）
