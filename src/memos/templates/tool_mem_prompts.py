TOOL_TRAJECTORY_PROMPT_ZH = """
你是一个专业的工具调用轨迹提取专家。你的任务是从给定的对话消息中提取完整的工具调用轨迹经验。

## 提取规则：
1. 只有当对话中存在有价值的工具调用过程时才进行提取
2. 有价值的轨迹至少包含以下元素：
   - 用户的问题（user message）
   - 助手的工具调用尝试（assistant message with tool_calls）
   - 工具的执行结果（tool message with tool_call_id and content，无论成功或失败）
   - 助手的响应（assistant message，无论是否给出最终答案）

## 输出格式：
返回一个JSON数组，格式如下：
```json
[
  {
    "trajectory": "自然语言输出包含'任务、使用的工具、工具观察、最终回答'的完整精炼的总结，体现顺序",
    "tool_used_status": [
      {
        "used_tool": "工具名1",
        "success_rate": "0.0-1.0之间的数值，表示该工具在本次轨迹中的成功率",
        "error_type": "调用失败时的错误类型和描述，成功时为空字符串",
        "experience": "该工具的使用经验，比如常见的参数模式、执行特点、结果解读方式等"
      }
    ]
  }
]
```

## 注意事项：
- 如果对话中没有完整的工具调用轨迹，返回空数组
- 每个轨迹必须是独立的完整过程
- 一个轨迹中可能涉及多个工具的使用，每个工具在tool_used_status中独立记录
- 只提取事实内容，不要添加任何解释或额外信息
- 确保返回的是有效的JSON格式

请分析以下对话消息并提取工具调用轨迹：

{messages}

"""


TOOL_TRAJECTORY_PROMPT_EN = """
You are a professional tool call trajectory extraction expert. Your task is to extract valuable tool call trajectory experiences from given conversation messages.

## Extraction Rules:
1. Only extract when there are valuable tool calling processes in the conversation
2. Valuable trajectories must contain at least the following elements:
   - User's question (user message)
   - Assistant's tool call attempt (assistant message with tool_calls)
   - Tool execution results (tool message with tool_call_id and content, regardless of success or failure)
   - Assistant's response (assistant message, whether or not a final answer is given)

## Output Format:
Return a JSON array in the following format:
```json
[
  {
    "trajectory": "Natural language summary containing 'task, tools used, tool observations, final answer' in a complete and refined manner, reflecting the sequence",
    "tool_used_status": [
      {
        "used_tool": "Tool Name 1",
        "success_rate": "Numerical value between 0.0-1.0, indicating the success rate of this tool in the current trajectory",
        "error_type": "Error type and description when call fails, empty string when successful",
        "experience": "Usage experience of this tool, such as common parameter patterns, execution characteristics, result interpretation methods, etc."
      }
    ]
  }
]
```

## Notes:
- If there are no complete tool call trajectories in the conversation, return an empty array
- Each trajectory must be an independent complete process
- Multiple tools may be used in one trajectory, each tool is recorded independently in tool_used_status
- Only extract factual content, do not add any additional explanations or information
- Ensure the returned content is valid JSON format

Please analyze the following conversation messages and extract tool call trajectories:

{messages}

"""
