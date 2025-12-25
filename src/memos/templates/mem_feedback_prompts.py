KEYWORDS_REPLACE = """
**Instruction:**
Please analyze the user's input text to determine if it is a "keyword replacement" request. If yes, follow these steps:

1.  **Identify the request type**: Confirm whether the user is asking to replace a specific word or phrase with another **within a specified scope**.
2.  **Extract the modification scope**: Determine the scope where the modification should apply.
 - If the user mentions a specific **document, file, or material identifier** (e.g., "in the Q1 operations plan", "in the prospectus numbered BT7868"), extract this description as the document scope.
 - **If the user does not explicitly specify any scope, mark the scope as "NONE"**.
3.  **Extract the original term (A)**: Identify the original word or phrase the user wants to be replaced.
4.  **Extract the target term (B)**: Identify the target word or phrase the user wants to replace it with.

**Output JSON Format**:
{{
    "if_keyword_replace": "true" | "false",
    "doc_scope": "[Extracted specific file or document description]" | "NONE" | null,
    "original": "[Extracted original word or phrase A]" | null,
    "target": "[Extracted target word or phrase B]" | null
}}
- **If it is NOT a replacement request**, set `if_keyword_replace` to `"false"`, and set the values for `doc_scope`, `original`, and `target` to `null`.
- **If it IS a replacement request**, set `if_keyword_replace` to `"true"` and fill in the remaining fields. If the user did not specify a scope, set `doc_scope` to `"NONE"`.

**Examples**:

1.  **User Input**: "In the file `User_Agreement.docx`, replace 'Party B' with 'User'."
    **Output**:
    {{
      "if_keyword_replace": "true",
      "doc_scope": "User_Agreement.docx",
      "original": "Party B",
      "target": "User"
    }}

2.  **User Input**: "Change 'Homepage' to 'Front Page'."
    **Output**:
    {{
      "if_keyword_replace": "true",
      "doc_scope": "NONE",
      "original": "Homepage",
      "target": "Front Page"
    }}

3.  **User Input**: "Does this sentence need modification?"
    **Output**:
    {{
      "if_keyword_replace": "false",
      "doc_scope": null,
      "original": null,
      "target": null
    }}

**User Input**
{user_feedback}

**Output**:
"""


KEYWORDS_REPLACE_ZH = """
**指令：**
请分析用户输入的文本，判断是否为“关键词替换”需求。 如果是，请按以下步骤处理：

1.  **识别需求类型**：确认用户是否要求将**特定范围**内的某个词或短语替换为另一个词或短语。
2.  **提取修改范围**：确定用户指定的修改生效范围。
 - 如果用户提及了具体的**文档、文件或资料标识**（如“在第一季运营方案”、“编号为BT7868的招股书”），则提取此描述作为文件范围。
 - **如果用户未明确指定任何范围，则范围标记为 "NONE"**。
3.  **提取原始词汇（A）**：找出用户希望被替换的原始词或短语。
4.  **提取目标词汇（B）**：找出用户希望替换成的目标词或短语。

**输出JSON格式**：
{{
    "if_keyword_replace": "true" | "false",
    "doc_scope": "[提取的具体文件或文档描述]" | "NONE" | null,
    "original": "[提取的原始词或短语A]" | null,
    "target": "[提取的目标词或短语B]" | null
}}
- **如果不是替换需求**，将 `if_keyword_replace` 设为 `"false"`，并将 `doc_scope`、`original`、`target` 三个键的值都设为 `null`。
- **如果是替换需求**，将 `if_keyword_replace` 设为 `"true"`，并填充其余字段。如果用户未指定范围，`doc_scope` 设为 `"NONE"`。


**示例**：

1.  **用户输入**：“在`用户协议.docx`这个文件中，把‘乙方’替换为‘用户’。”
    **输出**：
    {{
      "if_keyword_replace": "true",
      "doc_scope": "用户协议.docx",
      "original": "乙方",
      "target": "用户"
    }}

2.  **用户输入**：“把‘主页’改成‘首页’。”
    **输出**：
    {{
      "if_keyword_replace": "true",
      "doc_scope": "NONE",
      "original": "主页",
      "target": "首页"
    }}

3.  **用户输入**：“这个句子需要修改吗？”
    **输出**：
    {{
      "if_keyword_replace": "false",
      "doc_scope": null,
      "original": null,
      "target": null
    }}


**用户输入**
{user_feedback}

**输出**：
"""


FEEDBACK_JUDGEMENT_PROMPT = """You are a answer quality analysis expert. Please strictly follow the steps and criteria below to analyze the provided "User and Assistant Chat History" and "User Feedback," and fill the final evaluation results into the specified JSON format.

Analysis Steps and Criteria:
1. *Validity Judgment*:
 - Valid (true): The content of the user's feedback is related to the topic, task, or the assistant's last response in the chat history. For example: asking follow-up questions, making corrections, providing supplements, or evaluating the last response.
 - Invalid (false): The user's feedback is entirely unrelated to the conversation history, with no semantic, topical, or lexical connection to any prior content.

2. *User Attitude Judgment*:
 - Dissatisfied: The feedback shows negative emotions, such as directly pointing out errors, expressing confusion, complaining, criticizing, or explicitly stating that the problem remains unsolved.
 - Satisfied: The feedback shows positive emotions, such as expressing thanks or giving praise.
 - Irrelevant: The content of the feedback is unrelated to evaluating the assistant's answer.

3. *Summary Information Generation*(corrected_info field):
 - Generate a concise list of factual statements that summarize the core information from the user's feedback.
 - When the feedback provides corrections, focus only on the corrected information.
 - When the feedback provides supplements, integrate all valid information (both old and new).
 - It is very important to keep any relevant time information and express time information as concrete, unambiguous date(s) or period(s) (e.g., "March 2023", "2024-07", or "May–June 2022").
 - For 'satisfied' attitude, this list may contain confirming statements or be empty if no new facts are provided.
 - Focus on statement of objective facts. For example: "The user completed the Everest Circuit trek with colleagues in March 2023."

Output Format:
[
    {{
        "validity": "<string, 'true' or 'false'>",
        "user_attitude": "<string, 'dissatisfied' or 'satisfied' or 'irrelevant'>",
        "corrected_info": "<string, factual information records written in English>",
        "key": "<string, anique and concise memory title in English for quick identification of the core content (2-5 words)>",
        "tags": "<A list of relevant thematic keywords in English for categorization and retrieval (1-3 words per tag, e.g., ['deadline', 'team', 'planning'])>"
    }}
]

Example1:
Dialogue History:
user: I can't eat spicy food these days. Can you recommend some suitable restaurants for me?
assistant: Sure, I recommend the Fish Restaurant near you. Their signature dishes include various types of steamed seafood and sashimi of sea fish.
feedback time: 2023-1-18T14:25:00.856481

User Feedback:
Oh，No！I'm allergic to seafood！And I don't like eating raw fish.

Output:
[
    {{
        "validity": "true",
        "user_attitude": "dissatisfied",
        "corrected_info": "User is allergic to seafood and does not like eating raw fish.",
        "key": "dietary restrictions",
        "tags": ["allergic", "seafood", "raw fish", "food preference"]
    }}
]

Example2:
Dialogue History:
user: When did I bought on November 25, 2025?
assistant: A red coat
feedback time: 2025-11-28T20:45:00.875249

User Feedback:
No, I also bought a blue shirt.

Output:
[
    {{
        "validity": "true",
        "user_attitude": "dissatisfied",
        "corrected_info": "User bought a red coat and a blue shirt on November 25, 2025",
        "key": "shopping record",
        "tags": ["purchase", "clothing", "shopping"]
    }}
]

Example3:
Dialogue History:
user: What's my favorite food?
assistant: Pizza and sushi
feedback time: 2024-07-15T10:30:00.000000

User Feedback:
Wrong! I hate sushi. I like burgers.

Output:
[
    {{
        "validity": "true",
        "user_attitude": "dissatisfied",
        "corrected_info": "User likes pizza and burgers, but hates sushi.",
        "key": "food preferences",
        "tags": ["food preferences", "pizza", "burgers", "sushi"]
    }}
]

Dialogue History:
{chat_history}

feedback time: {feedback_time}

User Feedback:
{user_feedback}

Output:"""

FEEDBACK_JUDGEMENT_PROMPT_ZH = """您是一个回答质量分析专家。请严格按照以下步骤和标准分析提供的"用户与助手聊天历史"和"用户反馈"，并将最终评估结果填入指定的JSON格式中。

分析步骤和标准：
1. *有效性判断*：(validity字段)
   - 有效（true）：用户反馈的内容与聊天历史中的主题、任务或助手的最后回复相关。例如：提出后续问题、进行纠正、提供补充或评估最后回复。
   - 无效（false）：用户反馈与对话历史完全无关，与之前内容没有任何语义、主题或词汇联系。

2. *用户态度判断*：(user_attitude字段)
   - 不满意：反馈显示负面情绪，如直接指出错误、表达困惑、抱怨、批评，或明确表示问题未解决。
   - 满意：反馈显示正面情绪，如表达感谢或给予赞扬。
   - 无关：反馈内容与评估助手回答无关。

3. *摘要信息生成*（corrected_info字段）：
   - 从用户反馈中总结核心信息，生成简洁的事实陈述列表。
   - 当反馈提供纠正时，仅关注纠正后的信息。
   - 当反馈提供补充时，整合所有有效信息（包括旧信息和新信息）。
   - 非常重要：保留相关时间信息，并以具体、明确的日期或时间段表达（例如："2023年3月"、"2024年7月"或"2022年5月至6月"）。
   - 对于"满意"态度，此列表可能包含确认性陈述，如果没有提供新事实则为空。
   - 专注于客观事实陈述。例如："用户于2023年3月与同事完成了珠峰环线徒步。"

输出格式：
[
    {{
        "validity": "<字符串，'true' 或 'false'>",
        "user_attitude": "<字符串，'dissatisfied' 或 'satisfied' 或 'irrelevant'>",
        "corrected_info": "<字符串，用中文书写的事实信息记录>",
        "key": "<字符串，简洁的中文记忆标题，用于快速识别该条目的核心内容（2-5个汉字）>",
        "tags": "<列表，中文关键词列表（每个标签1-3个汉字），用于分类和检索>"
    }}
]

示例1：
对话历史：
用户：这些天我不能吃辣。能给我推荐一些合适的餐厅吗？
助手：好的，我推荐您附近的鱼类餐厅。他们的招牌菜包括各种蒸海鲜和海鱼生鱼片。
反馈时间：2023-1-18T14:25:00.856481

用户反馈：
哦，不！我对海鲜过敏！而且我不喜欢吃生鱼。

输出：
[
    {{
        "validity": "true",
        "user_attitude": "dissatisfied",
        "corrected_info": "用户对海鲜过敏且不喜欢吃生鱼",
        "key": "饮食限制",
        "tags": ["过敏", "海鲜", "生鱼", "饮食偏好"]
    }}
]

示例2：
对话历史：
用户：我2025年11月25日买了什么？
助手：一件红色外套
反馈时间：2025-11-28T20:45:00.875249

用户反馈：
不对，我还买了一件蓝色衬衫。

输出：
[
    {{
        "validity": "true",
        "user_attitude": "dissatisfied",
        "corrected_info": "用户于2025年11月25日购买了一件红色外套和一件蓝色衬衫",
        "key": "购物记录",
        "tags": ["红色外套", "蓝色衬衫", "服装购物"]
    }}
]

示例3：
对话历史：
用户：我最喜欢的食物是什么？
助手：披萨和寿司
反馈时间：2024-07-15T10:30:00.000000

用户反馈：
错了！我讨厌寿司。我喜欢汉堡。

输出：
[
    {{
        "validity": "true",
        "user_attitude": "dissatisfied",
        "corrected_info": "用户喜欢披萨和汉堡，但讨厌寿司",
        "key": "食物偏好",
        "tags": ["偏好", "披萨和汉堡"]
    }}
]

对话历史：
{chat_history}

反馈时间：{feedback_time}

用户反馈：
{user_feedback}

输出："""

UPDATE_FORMER_MEMORIES = """Operation recommendations:
Please analyze the newly acquired factual information and determine how this information should be updated to the memory database: add, update, or keep unchanged, and provide final operation recommendations.
You must strictly return the response in the following JSON format:

{{
    "operations":
        [
            {{
                "id": "<memory ID>",
                "text": "<memory content>",
                "operation": "<operation type, must be one of 'ADD', 'UPDATE', 'NONE'>",
                "old_memory": "<original memory content, required only when operation is 'UPDATE'>"
            }},
            ...
        ]
}}

*Requirements*:
1. If the new fact does not provide additional information to the existing memory item, or the existing memory can override the new fact, and the operation is set to "NONE."
2. If the new fact is similar to existing memory **about the same entity** but the information is more accurate, complete, or requires correction, set operation to "UPDATE"
3. If the new fact contradicts existing memory in key information (such as time, location, status, etc.), update the original memory based on the new fact and set operation to "UPDATE", only modifying the relevant error segments in the existing memory paragraphs while keeping other text completely unchanged.
4. If there is no existing memory that requires updating **or if the new fact refers to a different entity**, the new fact is added as entirely new information, and the operation is set to "ADD." Therefore, in the same operation list, ADD and UPDATE will not coexist.
5. Facts about different entities that were acknowledged by the user within the same time period can coexist and are not considered contradictory.

*ID Management Rules*:
- Update operation: Keep the original ID unchanged
- Add operation: Generate a new unique ID in the format of a 4-digit string (e.g., "0001", "0002", etc.)

*Important Requirements*:
1. For "UPDATE" operations, you must provide the old_memory field to display the original content
2. Compare existing memories one by one and do not omit any content requiring updates. When multiple existing memories need updating, include all relevant entries in the operation list
3. "text" field requirements:
 - Use concise, complete declarative sentences, avoiding redundant information
 - "text" should record the final adopted memory: if judged as "ADD", output text as "new fact"; if judged as "UPDATE", output text as "adjusted new fact"; if judged as "NONE", output text as "existing memory"
 - When updating, ensure that only the related error segments are modified, and other text remains completely unchanged.
4. Both text and old_memory content should be in English
5. Return only the JSON format response, without any other content



Example1:
Current Memories:
"0911": "The user is a senior full-stack developer working at Company B"
"123": "The user works as a software engineer at Company A. And he has a good relationship with his wife."
"648": "The user is responsible for front-end development of software at Company A"
"7210": "The user is responsible for front-end development of software at Company A"
"908": "The user enjoys fishing with friends on weekends"

The background of the new fact being put forward:
user: Do you remember where I work？
assistant: Company A.
user feedback: I work at Company B, and I am a senior full-stack developer.

Newly facts:
The user works as a senior full-stack developer at Company B

Operation recommendations:
{{
    "operations":
        [
            {{
                "id": "0911",
                "text": "The user is a senior full-stack developer working at Company B",
                "operation": "NONE"
            }},
            {{
                "id": "123",
                "text": "The user works as a senior full-stack developer at Company B. And he has a good relationship with his wife.",
                "operation": "UPDATE",
                "old_memory": "The user works as a software engineer at Company A. And he has a good relationship with his wife."
            }},
            {{
                "id": "648",
                "text": "The user works as a senior full-stack developer at Company B",
                "operation": "UPDATE",
                "old_memory": "The user is responsible for front-end development of software at Company A"
            }},
            {{
                "id": "7210",
                "text": "The user works as a senior full-stack developer at Company B",
                "operation": "UPDATE",
                "old_memory": "The user is responsible for front-end development of software at Company A"
            }},
            {{
                "id": "908",
                "text": "The user enjoys fishing with friends on weekends",
                "operation": "NONE"
            }}
        ]
}}

Example2:
Current Memories:
"123": "On December 22, 2025, the user claim that John works at Company X"
"908": "On December 22, 2025, the user claim that Mary lives in New York"

The background of the new fact being put forward:
user: Guess who am I？
assistant: You are a teacher at School ABC.
user feedback: No, I mean Peter is a teacher at School ABC.

Newly facts:
"Peter is a teacher at School ABC."

Operation recommendations:
{{
    "operations":
        [
            {{
                "id": "123",
                "text": "On December 22, 2025, the user claim that John works at Company X",
                "operation": "NONE"
            }},
            {{
                "id": "908",
                "text": "On December 22, 2025, the user claim that Mary lives in New York",
                "operation": "NONE"
            }},
            {{
                "id": "001",
                "text": "Peter is a teacher at School ABC.",
                "operation": "ADD"
            }}
        ]
}}

**Current time**
{now_time}

**Current Memories**
{current_memories}

**The background of the new fact being put forward**
{chat_history}

**Newly facts**
{new_facts}

Operation recommendations:
"""

UPDATE_FORMER_MEMORIES_ZH = """请分析新获取的事实信息，并决定这些信息应该如何更新到记忆库中：新增、更新、或保持不变，并给出最终的操作建议。

你必须严格按照以下JSON格式返回响应：

{{
    "operations":
        [
            {{
                "id": "<记忆ID>",
                "text": "<记忆内容>",
                "operation": "<操作类型，必须是 "ADD", "UPDATE", "NONE" 之一>",
                "old_memory": "<原记忆内容，仅当操作为"UPDATE"时需要提供>"
            }},
            ...
        ]
}}

要求：
1. 若新事实未对现有记忆条目提供额外信息，现有记忆可覆盖新事实，操作设为"NONE"
2. 若新事实与现有记忆相似但信息更准确、完整或需修正，操作设为"UPDATE"
3. 若新事实在关键信息（如时间、地点、状态等）上与现有记忆矛盾，则根据新事实更新原记忆，操作设为"UPDATE"，仅修改现有记忆段落中的相关错误片段，其余文本完全保持不变
4. 若无需要更新的现有记忆，则将新事实作为全新信息添加，操作设为"ADD"。因此在同一操作列表中，ADD与UPDATE不会同时存在
5. 同一时间段内用户所确认的不同实体的相关事实可以并存，且不会被视作相互矛盾。

ID管理规则：
- 更新操作：保持原有ID不变
- 新增操作：生成新的唯一ID，格式为4位数字字符串（如："0001", "0002"等）

重要要求：
1. 对于"UPDATE"更新操作，必须提供old_memory字段显示原内容
2. 对现有记忆逐一比对，不可漏掉需要更新的内容。当多个现有记忆需要更新时，将所有的相关条目都包含在操作列表中
3. text字段要求：
  - 使用简洁、完整的陈述句，避免冗余信息
  - text要记录最终采用的记忆，如果判为"ADD"，则text输出为"新事实"；如果判为"UPDATE"，则text输出为"调整后的新事实"；如果判为"NONE"，则text输出为"现有记忆"
  - 更新时确保仅修改相关错误片段，其余文本完全保持不变
4. text和old_memory内容使用中文
5. 只返回JSON格式的响应，不要包含其他任何内容


示例1：
当前记忆：
"0911": "用户是高级全栈开发工程师，在B公司工作"
"123": "用户在公司A担任软件工程师。而且用户和同事们的关系很好，他们共同协作大项目。"
"648": "用户在公司A负责软件的前端开发工作"
"7210": "用户在公司A负责软件的前端开发工作"
"908": "用户周末喜欢和朋友一起钓鱼"


提出新事实的背景：
user: 你还记得我现在在哪里工作吗？
assistant: A公司
user feedback: 实际上，我在公司B工作，是一名高级全栈开发人员。


新获取的事实：
"用户现在在公司B担任高级全栈开发工程师"

操作建议：
{{
    "operations":
        [
            {{
                "id": "0911",
                "text": "用户是高级全栈开发工程师，在B公司工作",
                "operation": "NONE"
            }},
            {{
                "id": "123",
                "text": "用户现在在公司B担任高级全栈开发工程师。而且用户和同事们的关系很好，他们共同协作大项目。",
                "operation": "UPDATE",
                "old_memory": "用户在公司A担任软件工程师，主要负责前端开发。而且用户和同事们的关系很好，他们共同协作大项目。"
            }},
            {{
                "id": "648",
                "text": "用户现在在公司B担任高级全栈开发工程师",
                "operation": "UPDATE",
                "old_memory": "用户在公司A负责软件的前端开发工作"
            }},
            {{
                "id": "7210",
                "text": "用户现在在公司B担任高级全栈开发工程师",
                "operation": "UPDATE",
                "old_memory": "用户在公司A负责软件的前端开发工作"
            }},
            {{
                "id": "908",
                "text": "用户周末喜欢和朋友一起钓鱼",
                "operation": "NONE"
            }}
        ]
}}

示例2：
当前记忆：
"123": "2025年12月12日，用户声明约翰在 X 公司工作"
"908": "2025年12月12日，用户声明玛丽住在纽约"

提出新事实的背景：
user: 猜猜刘青住在哪里？
assistant: 合欢社区
user feedback: 错了，他住在明月小区

新获取的事实：
"用户声明刘青住在明月小区"

操作建议：
{{
    "operations":
        [
            {{
                "id": "123",
                "text": "用户在公司A担任软件工程师，主要负责前端开发",
                "operation": "NONE"
            }},
            {{
                "id": "908",
                "text": "用户周末喜欢和朋友一起钓鱼",
                "operation": "NONE"
            }},
            {{
                "id": "4567",
                "text": "用户声明刘青住在明月小区",
                "operation": "ADD"
            }}
        ]
}}

**当前时间：**
{now_time}

**当前记忆：**
{current_memories}

**新事实提出的背景：**
{chat_history}

**新事实：**
{new_facts}

操作建议：
"""


FEEDBACK_ANSWER_PROMPT = """
You are a knowledgeable and helpful AI assistant.You have access to the history of the current conversation. This history contains the previous exchanges between you and the user.

# INSTRUCTIONS:
1. Carefully analyze the entire conversation history. Your answer must be based only on the information that has been exchanged within this dialogue.
2. Pay close attention to the sequence of the conversation. If the user refers back to a previous statement (e.g., "the thing I mentioned earlier"), you must identify that specific point in the history.
3. Your primary goal is to provide continuity and context from this specific conversation. Do not introduce new facts or topics that have not been previously discussed.
4. If current question is ambiguous, use the conversation history to clarify its meaning.

# APPROACH (Think step by step):
1. Review the conversation history to understand the context and topics that have been discussed.
2. Identify any specific details, preferences, or statements the user has made that are relevant to the current question.
3. Formulate a precise, concise answer that is a direct continuation of the existing dialogue.
4. Ensure your final answer is grounded in the conversation history and directly addresses the user's latest query in that context.

# Tip:
If no chat history is provided:
 - Treat the query as self-contained.
 - Do not assume prior context.
 - Respond based solely on the current question.
 - Do not raise new questions during the answering process.

Chat history:
{chat_history}

Question:
{question}

Answer:
"""

FEEDBACK_ANSWER_PROMPT_ZH = """
你是一个知识渊博且乐于助人的AI助手。你可以访问当前对话的完整历史记录。这些记录包含你与用户之间先前的所有交流内容。

# 指令：
1. 仔细分析整个对话历史。你的回答必须仅基于本次对话中已交流的信息。
2. 密切关注对话的先后顺序。如果用户提及之前的发言（例如“我之前提到的那件事”），你必须定位到历史记录中的具体内容。
3. 你的主要目标是基于本次特定对话提供连续性和上下文。不要引入之前对话中未讨论过的新事实或话题。
4. 如果用户当前的问题含义不明确，请利用对话历史来澄清其意图。

# 处理方法（逐步思考）：
1. 回顾对话历史，以理解已讨论的背景和主题。
2. 识别用户已提及的、与当前问题相关的任何具体细节、偏好或陈述。
3. 构思一个精准、简洁的回答，使其成为现有对话的直接延续。
4. 确保你的最终回答紧扣对话历史，并在此上下文中直接回应用户的最新提问。

# 注意:
如果没有提供聊天历史记录：
 - 将该查询视为独立的。
 - 不要假设之前存在背景信息。
 - 仅根据当前问题进行回答。
 - 在回答过程中不必提出新的问题。

对话历史：
{chat_history}

问题：
{question}

回答：
"""


OPERATION_UPDATE_JUDGEMENT = """
# Batch UPDATE Safety Assessment Instruction

**Background**:
This instruction serves as a supplementary safety verification layer for the memory update instruction. It evaluates each UPDATE operation in the `operations` list to ensure safety and effectiveness, preventing erroneous data overwrites.

**Input**: The `operations` list containing multiple UPDATE proposals generated by the main instruction
**Output**: The final `operations_judgement` list after safety assessment and necessary corrections

**Safety Assessment Process (for each UPDATE entry)**:
1. **Entity Consistency Check**: Verify that the old and new texts of this UPDATE entry describe exactly the same core entity (same person, organization, event, etc.). This is the most important check.
2. **Semantic Relevance Check**: Determine whether the new information directly corrects errors in or supplements missing information from the old information, rather than introducing completely unrelated new facts.
3. **Context Preservation Check**: Ensure that the updated text of this UPDATE only modifies the parts that need correction, while completely preserving all other valid information from the original text.

**Batch Assessment Rules**:
- Independently assess each entry in the list and record the evaluation results

**Key Decision Rules**:
1. If the core entities of old and new texts are different → Set `judgement` to "INVALID" (completely invalid)
2. If the core entities are the same but the information is completely unrelated → Set `judgement` to "NONE" (should not update)
3. If all three checks pass → Set `judgement` to "UPDATE_APPROVED"

**Output Format**:
{{
    "operations_judgement": [
        {{
            "id": "...",
            "text": "...",
            "old_memory": "...",
            "judgement": "INVALID" | "NONE" | "UPDATE_APPROVED"
        }},
        ...
    ]
}}

**Example 1**:
Input operations list:
{{
    "operations": [
        {{
            "id": "275a",
            "text": "On December 22, 2025 at 6:58 AM UTC, the user mentioned that Mission Terra is from Germany.",
            "operation": "UPDATE",
            "old_memory": "On December 13, 2025 at 4:02 PM UTC, the user mentioned that Mission Terra is a French national."
        }},
        {{
            "id": "88a4",
            "text": "On December 22, 2025 at 6:58 AM UTC, the user mentioned that Mission Terra is from Germany.",
            "operation": "UPDATE",
            "old_memory": "On December 22, 2025 at 6:52 AM UTC, the user confirmed that Gladys Liu is an Italian citizen."
        }}
    ]
}}

Safety assessment output:
{{
    "operations_judgement": [
        {{
            "id": "275a",
            "text": "On December 22, 2025 at 6:58 AM UTC, the user mentioned that Mission Terra is from Germany.",
            "old_memory": "On December 13, 2025 at 4:02 PM UTC, the user mentioned that Mission Terra is a French national.",
            "judgement": "UPDATE_APPROVED"
        }},
        {{
            "id": "88a4",
            "text": "On December 22, 2025 at 6:58 AM UTC, the user mentioned that Mission Terra is from Germany.",
            "old_memory": "On December 22, 2025 at 6:52 AM UTC, the user confirmed that Gladys Liu is an Italian citizen.",
            "judgement": "INVALID"
        }}
    ]
}}

**For actual execution**:
Input operations list:
{raw_operations}

Safety assessment output:"""


OPERATION_UPDATE_JUDGEMENT_ZH = """## 批量UPDATE安全评估指令

**背景说明**：
本指令作为记忆更新指令的补充安全验证层。针对`operations`列表，评估每个UPDATE操作都安全有效，防止错误的数据覆盖。

**输入**：主指令生成的包含多个UPDATE提议的`operations`列表
**输出**：经过安全评估和必要修正后的最终`operations_judgement`列表

**安全评估流程（针对每个UPDATE条目）**：
1. **实体一致性检查**：确认该UPDATE条目的新旧文本是否描述完全相同的核心实体（同一人物、组织、事件等）。这是最重要的检查。
2. **语义相关性检查**：判断该UPDATE的新信息是否直接修正旧信息中的错误部分或补充缺失信息，而非引入完全不相关的新事实。
3. **上下文保留检查**：确保该UPDATE更新后的文本只修改需要纠正的部分，完全保留原始文本中其他所有有效信息。

**批量评估规则**：
- 对列表中的每个条目独立评估，记录评估结果

**关键决策规则**：
1. 如果新旧文本核心实体不同 → `judgement`置为"INVALID"（完全无效）
2. 如果新旧文本核心实体相同但信息完全不相关 → `judgement`置为"NONE"（不应更新）
3. 如果通过全部三项检查 → `judgement`置为"UPDATE_APPROVED"


**输出格式**：
{{
    "operations_judgement": [
        // 评估后的完整operations列表
        {{
            "id": "...",
            "text": "...",
            "old_memory": "...",
            "judgement": "INVALID" | "NONE" | "UPDATE_APPROVED"
        }},
        ...
    ]
}}


示例1：
输入operations列表：
{{
    "operations": [
        {{
            "id": "275a",
            "text": "2025年12月22日 UTC 时间6:58，用户提到Mission Terra 来自德国。",
            "operation": "UPDATE",
            "old_memory": "2025年12月13日 UTC 时间16:02，用户提及 Mission Terra 是法国国籍。"
        }},
        {{
            "id": "88a4",
            "text": "2025年12月22日 UTC 时间6:58，用户提到Mission Terra 来自德国。",
            "operation": "UPDATE",
            "old_memory": "2025年12月22日 UTC 时间6:52，用户确认 Gladys Liu 是意大利公民。"
        }}
    ]
}}
安全评估输出：
{{
    "operations_judgement": [
        {{
            "id": "275a",
            "text": "2025年12月22日 UTC 时间6:58，用户提到Mission Terra 来自德国。",
            "old_memory": "2025年12月13日 UTC 时间16:02，用户提及 Mission Terra 是法国国籍。",
            "judgement": "UPDATE_APPROVED"
        }},
        {{
            "id": "88a4",
            "text": "2025年12月22日 UTC 时间6:58，用户提到Mission Terra 来自德国。",
            "old_memory": "2025年12月22日 UTC 时间6:52，用户确认 Gladys Liu 是意大利公民。",
            "judgement": "INVALID"
        }}
    ]
}}

输入operations列表：
{raw_operations}

安全评估输出：
"""
