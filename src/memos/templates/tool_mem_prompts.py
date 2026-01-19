TOOL_TRAJECTORY_PROMPT_ZH = """
你是一个专业的工具经验提取专家。你的任务是从给定的对话消息中提取完整的工具调用轨迹经验。

## 分析判断步骤：
**步骤1：判断任务完成度**
根据用户反馈，判定correctness：success（成功）或 failed（失败），用户反馈决定权大于执行结果，用户反馈有误，则判定为failed

**步骤2：成功轨迹（success）- 经验提炼**
从成功模式中提炼通用原则或规则，采用"when...then..."结构：
- when: 明确描述触发该经验的场景特征（任务类型、工具环境、参数特征等）
- then: 总结有效的参数模式、调用策略、最佳实践
注意：经验是解决整个轨迹问题级别的，不仅仅针对单个工具

**步骤3：失败轨迹（failed）- 错误分析与经验提炼**
3.1 工具需求判断
  - 任务是否需要工具？（需要/直接回答/误调用）
3.2 工具调用检查
  - 工具存在性：是否在system中提供
  - 工具选择：是否选对工具
  - 参数正确性：是否符合类型定义
  - 幻觉检测：是否调用不存在的工具
3.3 错误根因定位
  结合消息中的错误反馈信息和上述分析，精准输出根本原因
3.4 经验提炼（核心）
  从失败模式中提炼通用原则或规则，采用"when...then..."结构：
  - when: 明确描述触发该经验的场景特征（任务类型、工具环境、参数特征等）
  - then: 给出避免错误的通用策略、正确调用方式或决策规则
  注意：经验是解决整个轨迹问题级别的，不仅仅针对单个工具

## 输出格式：
返回一个JSON数组，格式如下：

```json
[
  {
    "correctness": "success 或 failed",
    "trajectory": "精炼完整的自然语言总结，包含：[任务（用户任务） -> 执行动作（调用的工具/直接回答） -> 执行结果] (可能多轮) -> 最终回答",
    "experience": "采用when...then...格式，例如：'when 遇到XX的任务时，应该YY'",
    "tool_used_status": [
      {
        "used_tool": "工具名称（如果调用了工具）",
        "success_rate": "0.0-1.0之间的数值，表示该工具在本次轨迹中的成功率",
        "error_type": "调用失败时的错误类型和描述，成功时为空字符串",
        "tool_experience": "调用该工具的经验，包括可能的前置条件和可能的后置效果"
      }
    ]
  }
]
```

## 注意事项：
- 每个轨迹必须是独立的完整过程
- 一个轨迹中可能涉及多个工具的使用，每个工具在tool_used_status中独立记录
- 如果没有调用工具，tool_used_status为空数组[]
- 如果多条轨迹存在顺序依赖关系，需要将它们视为一条轨迹
- 只提取事实内容，不要添加任何解释或额外信息
- 确保返回的是有效的JSON格式
- 输出的trajectory需要按照messages的发展顺序排列
- experience必须是通用的、可复用的经验规则，而不是针对具体案例的描述
- 无论成功或失败，都要提炼经验并使用when...then...格式

请分析以下对话消息并提取工具调用轨迹，基于以下对话消息：
<messages>
{messages}
</messages>
"""


TOOL_TRAJECTORY_PROMPT_EN = """
You are a professional tool experience extraction expert. Your task is to extract complete tool call trajectory experiences from given conversation messages.

## Analysis and Judgment Steps:

**Step 1: Assess Task Completion**
Determine correctness based on user feedback: success or failed, user feedback has higher priority than execution results, if user feedback is incorrect, then determine as failed

**Step 2: Successful Trajectory (success) - Experience Extraction**
Extract general principles or rules from success patterns, using "when...then..." structure:
- when: clearly describe the scenario characteristics that trigger this experience (task type, tool environment, parameter characteristics, etc.)
- then: summarize effective parameter patterns, calling strategies, and best practices
Note: Experience is at the trajectory-level problem-solving, not just for a single tool

**Step 3: Failed Trajectory (failed) - Error Analysis and Experience Extraction**

3.1 Tool Requirement Assessment
  - Does the task require tools? (required/direct answer/unnecessary call)

3.2 Tool Call Verification
  - Tool availability: provided in system?
  - Tool selection: correct tool chosen?
  - Parameter correctness: conform to type definitions?
  - Hallucination detection: calling non-existent tools?

3.3 Root Cause Identification
  Combine error feedback from messages with above analysis to precisely output root cause

3.4 Experience Extraction (Core)
  Extract general principles or rules from failure patterns, using "when...then..." structure:
  - when: clearly describe the scenario characteristics that trigger this experience (task type, tool environment, parameter characteristics, etc.)
  - then: provide general strategies to avoid errors, correct calling approaches, or decision rules
  Note: Experience is at the trajectory-level problem-solving, not just for a single tool

## Output Format:
Return a JSON array in the following format:

```json
[
  {
    "correctness": "success or failed",
    "trajectory": "Concise and complete natural language summary including: [task (user task) -> execution action (tool called/direct answer) -> execution result] (possibly multiple rounds) -> final answer",
    "experience": "Use when...then... format, e.g., 'when encountering XX tasks, should do YY'",
    "tool_used_status": [
      {
        "used_tool": "Tool name (if tool was called)",
        "success_rate": "Numerical value between 0.0-1.0, indicating the success rate of this tool in current trajectory",
        "error_type": "Error type and description when call fails, empty string when successful",
        "tool_experience": "Experience of using this tool, including possible preconditions and possible post-effects"
      }
    ]
  }
]
```

## Notes:
- Each trajectory must be an independent complete process
- A trajectory may involve multiple tools, each recorded independently in tool_used_status
- If no tool was called, tool_used_status is an empty array []
- If multiple trajectories have sequential dependencies, treat them as one trajectory
- Only extract factual content, do not add any explanations or extra information
- Ensure the returned content is valid JSON format
- The trajectory should be arranged according to the development order of messages
- Experience must be general and reusable rules, not descriptions specific to concrete cases
- Whether success or failed, always extract experience using when...then... format

Please analyze the following conversation messages and extract tool call trajectories based on:
<messages>
{messages}
</messages>
"""
