TOOL_TRAJECTORY_PROMPT_ZH = """
你是一个专业的工具调用轨迹提取专家。你的任务是从给定的对话消息中提取完整的工具调用轨迹经验。

## 提取规则：
1. 只有当对话中存在有价值的工具调用经验时才进行提取
2. 有价值的轨迹包含两种情况：

   **情况A - 标准工具调用轨迹**（包含以下完整流程）：
   - 用户的问题（user message）
   - 助手的工具调用尝试（assistant message with tool_calls）
   - 工具的执行结果（tool message with tool_call_id and content，无论成功或失败）
   - 助手基于工具结果的响应（assistant message）

   **情况B - 无需工具调用的轨迹**（同时满足以下条件）：
   - 对话中提供了可用的工具列表
   - 助手没有进行任何工具调用
   - 直接给出了答案并获得正确反馈
   - 这种情况需要提取并标注"此问题无需工具调用即可回答"

## 输出格式：
返回一个JSON数组，格式如下：

**情况A的输出格式：**
```json
[
  {
    "trajectory": "自然语言输出包含'任务、使用的工具、工具观察、最终回答'的完整精炼的总结，体现顺序",
    "experience": "成功时总结参数模式和最佳实践；失败时反思总结教训和注意事项，以及可能的正确解法"
    "tool_used_status": [
      {
        "used_tool": "工具名1",
        "success_rate": "0.0-1.0之间的数值，表示该工具在本次轨迹中的成功率",
        "error_type": "调用失败时的错误类型和描述，成功时为空字符串",
      }
    ]
  }
]
```

**情况B的输出格式：**
```json
[
  {
    "trajectory": "自然语言输出说明'任务内容、为什么不需要工具调用、最终回答'",
    "experience": "成功时总结参数模式和最佳实践；失败时反思总结教训和注意事项，以及可能的正确解法"
    "tool_used_status": []
  }
]
```

## 注意事项：
- **trajectory 必须精简**：用最少的文字清晰表达完整流程，避免冗长描述
- 如果对话中没有完整的工具调用轨迹（情况A）且不符合（情况B）的条件，返回空数组
- 每个轨迹必须是独立的完整过程
- 一个轨迹中可能涉及多个工具的使用，每个工具在tool_used_status中独立记录
- 如果多条轨迹存在顺序依赖关系，需要将它们视为一条轨迹
- 只提取事实内容，不要添加任何解释或额外信息
- 确保返回的是有效的JSON格式

请分析以下对话消息并提取工具调用轨迹：

{messages}

"""


TOOL_TRAJECTORY_PROMPT_EN = """
You are a professional tool call trajectory extraction expert. Your task is to extract valuable tool call trajectory experiences from given conversation messages.

## Extraction Rules:
1. Only extract when there are valuable tool calling experiences in the conversation
2. Valuable trajectories include two scenarios:

   **Scenario A - Standard Tool Call Trajectory** (contains the complete flow):
   - User's question (user message)
   - Assistant's tool call attempt (assistant message with tool_calls)
   - Tool execution results (tool message with tool_call_id and content, regardless of success or failure)
   - Assistant's response based on tool results (assistant message)

   **Scenario B - No Tool Call Needed Trajectory** (must meet all conditions):
   - Tools are provided in the conversation
   - Assistant made no tool calls
   - Assistant directly provided an answer and received correct feedback
   - This should be extracted with annotation "This question can be answered without tool calls"

## Output Format:
Return a JSON array in the following format:

**Format for Scenario A:**
```json
[
  {
    "trajectory": "Natural language summary containing 'task, tools used, tool observations, final answer' in a complete and refined manner, reflecting the sequence",
    "experience": "When successful, summarize parameter patterns and best practices; when failed, reflect on lessons learned, precautions, and possible correct solutions",
    "tool_used_status": [
      {
        "used_tool": "Tool Name 1",
        "success_rate": "Numerical value between 0.0-1.0, indicating the success rate of this tool in the current trajectory",
        "error_type": "Error type and description when call fails, empty string when successful"
      }
    ]
  }
]
```

**Format for Scenario B:**
```json
[
  {
    "trajectory": "Natural language description of 'task content, why tool calls are not needed, final answer'",
    "experience": "When successful, summarize parameter patterns and best practices; when failed, reflect on lessons learned, precautions, and possible correct solutions",
    "tool_used_status": []
  }
]
```

## Notes:
- **trajectory must be concise**: Express the complete process clearly with minimal words, avoid lengthy descriptions
- If there are no complete tool call trajectories (Scenario A) and (Scenario B) conditions are not met, return an empty array
- Each trajectory must be an independent complete process
- Multiple tools may be used in one trajectory, each tool is recorded independently in tool_used_status
- If multiple trajectories have sequential dependencies, they should be considered as one trajectory
- Only extract factual content, do not add any additional explanations or information
- Ensure the returned content is valid JSON format

Please analyze the following conversation messages and extract tool call trajectories:

{messages}

"""
