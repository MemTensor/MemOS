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


UPDATE_FORMER_MEMORIES = """Please analyze the newly acquired factual information and determine how this information should be updated to the memory database: add, update, or keep unchanged, and provide final operation recommendations.

You must strictly return the response in the following JSON format:

{{
    "operation":
        [
            {{
                "id": "<memory ID>",
                "text": "<memory content>",
                "event": "<operation type, must be one of 'ADD', 'UPDATE', 'NONE'>",
                "old_memory": "<original memory content, required only when operation is 'UPDATE'>"
            }},
            ...
        ]
}}

*Requirements*:
1. If the new fact does not provide additional information to the existing memory item, the existing memory can override the new fact, and the operation is set to "NONE."
2. If the new fact is similar to existing memory but the information is more accurate, complete, or requires correction, set operation to "UPDATE"
3. If the new fact contradicts existing memory in key information (such as time, location, status, etc.), update the original memory based on the new fact and set operation to "UPDATE"
4. If there is no existing memory that requires updating, the new fact is added as entirely new information, and the operation is set to "ADD." Therefore, in the same operation list, ADD and UPDATE will not coexist.


*ID Management Rules*:
- Update operation: Keep the original ID unchanged
- Add operation: Generate a new unique ID in the format of a 4-digit string (e.g., "0001", "0002", etc.)

*Important Requirements*:
- For update operations, you must provide the old_memory field to show the original content
- Compare the existing memories one by one and do not miss any content that needs to be updated. When multiple existing memories need to be updated, include all relevant entries in the operation list

If the new fact contradicts existing memory in key information (such as time, location, status, etc.), update ALL affected original memories based on the new fact and set operation to "UPDATE" for each one. Multiple memories covering the same outdated information should all be updated.
- Return only the JSON format response, without any other content
- text field requirements: Use concise, complete declarative sentences that are consistent with the newly acquired factual information, avoiding redundant information
- text and old_memory content should be in English

Example1:
Current Memories:
{{
    "memory": [
        {{
            "id": "0911",
            "text": "The user is a senior full-stack developer working at Company B"
        }},
        {{
            "id": "123",
            "text": "The user works as a software engineer at Company A, primarily responsible for front-end development"
        }},
        {{
            "id": "648",
            "text": "The user is responsible for front-end development of software at Company A"
        }},
        {{
            "id": "7210",
            "text": "The user is responsible for front-end development of software at Company A"
        }},
        {{
            "id": "908",
            "text": "The user enjoys fishing with friends on weekends"
        }}
    ]
}}

The background of the new fact being put forward:
user: Do you remember where I work？
assistant: Company A.
user feedback: I work at Company B, and I am a senior full-stack developer.

Newly facts:
"The user works as a senior full-stack developer at Company B"

Operation recommendations:
{{
    "operation":
        [
            {{
                "id": "0911",
                "text": "The user is a senior full-stack developer working at Company B",
                "event": "NONE"
            }},
            {{
                "id": "123",
                "text": "The user works as a senior full-stack developer at Company B",
                "event": "UPDATE",
                "old_memory": "The user works as a software engineer at Company A, primarily responsible for front-end development"
            }},
            {{
                "id": "648",
                "text": "The user works as a senior full-stack developer at Company B",
                "event": "UPDATE",
                "old_memory": "The user is responsible for front-end development of software at Company A"
            }},
            {{
                "id": "7210",
                "text": "The user works as a senior full-stack developer at Company B",
                "event": "UPDATE",
                "old_memory": "The user is responsible for front-end development of software at Company A"
            }},
            {{
                "id": "908",
                "text": "The user enjoys fishing with friends on weekends",
                "event": "NONE"
            }}
        ]
}}

Example2:
Current Memories:
{{
    "memory": [
        {{
            "id": "123",
            "text": "The user works as a software engineer in Company A, mainly responsible for front-end development"
        }},
        {{
            "id": "908",
            "text": "The user likes to go fishing with friends on weekends"
        }}
    ]
}}

The background of the new fact being put forward:
user: Guess where I live？
assistant: Hehuan Community.
user feedback: Wrong, update my address: Mingyue Community, Chaoyang District, Beijing

Newly facts:
"The user's residential address is Mingyue Community, Chaoyang District, Beijing"

Operation recommendations:
{{
    "operation":
        [
            {{
                "id": "123",
                "text": "The user works as a software engineer at Company A, primarily responsible for front-end development",
                "event": "NONE"
            }},
            {{
                "id": "908",
                "text": "The user enjoys fishing with friends on weekends",
                "event": "NONE"
            }},
            {{
                "id": "4567",
                "text": "The user's residential address is Mingyue Community, Chaoyang District, Beijing",
                "event": "ADD"
            }}
        ]
}}

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
    "operation":
        [
            {{
                "id": "<记忆ID>",
                "text": "<记忆内容>",
                "event": "<操作类型，必须是 "ADD", "UPDATE", "NONE" 之一>",
                "old_memory": "<原记忆内容，仅当操作为"UPDATE"时需要提供>"
            }},
            ...
        ]
}}

要求：
1. 如果新事实对现有记忆item没有额外补充，现有记忆的信息可以覆盖新事实，设置操作为"NONE"
2. 如果新事实与现有记忆item相似但信息更准确、完整或需要修正，设置操作为"UPDATE"
3. 如果新事实与现有记忆在关键信息上矛盾（如时间、地点、状态等），以新事实为准更新原有记忆，设置操作为"UPDATE"
4. 如果现有记忆中没有需要更新的，则新事实作为全新信息添加，设置操作为"ADD"。因此可知同一个 operation 列表中，ADD和UPDATE不会同时存在。

ID管理规则：
- 更新操作：保持原有ID不变
- 新增操作：生成新的唯一ID，格式为4位数字字符串（如："0001", "0002"等）

重要要求：
- 对于更新操作，必须提供old_memory字段显示原内容
- 对现有记忆逐一比对，不可漏掉需要更新的内容。当多个现有记忆需要更新时，将所有的相关条目都包含在操作列表中
- 只返回JSON格式的响应，不要包含其他任何内容
- text字段要求：使用简洁、完整的陈述句，和新获取的事实信息一致，避免冗余信息
- text和old_memory内容使用中文

示例1：
现有记忆记录：
{{
    "memory": [
        {{
            "id": "0911",
            "text": "用户是高级全栈开发工程师，在B公司工作"
        }},
        {{
            "id": "123",
            "text": "用户在公司A担任软件工程师，主要负责前端开发"
        }},
        {{
            "id": "648",
            "text": "用户在公司A负责软件的前端开发工作"
        }},
        {{
            "id": "7210",
            "text": "用户在公司A负责软件的前端开发工作"
        }},
        {{
            "id": "908",
            "text": "用户周末喜欢和朋友一起钓鱼"
        }}
    ]
}}

提出新事实的背景：
user: 你还记得我现在在哪里工作吗？
assistant: A公司
user feedback: 实际上，我在公司B工作，是一名高级全栈开发人员。


新获取的事实：
"用户现在在公司B担任高级全栈开发工程师"

操作建议：
{{
    "operation":
        [
            {{
                "id": "0911",
                "text": "用户是高级全栈开发工程师，在B公司工作",
                "event": "NONE"
            }},
            {{
                "id": "123",
                "text": "用户现在在公司B担任高级全栈开发工程师",
                "event": "UPDATE",
                "old_memory": "用户在公司A担任软件工程师，主要负责前端开发"
            }},
            {{
                "id": "648",
                "text": "用户现在在公司B担任高级全栈开发工程师",
                "event": "UPDATE",
                "old_memory": "用户在公司A负责软件的前端开发工作"
            }},
            {{
                "id": "7210",
                "text": "用户现在在公司B担任高级全栈开发工程师",
                "event": "UPDATE",
                "old_memory": "用户在公司A负责软件的前端开发工作"
            }},
            {{
                "id": "908",
                "text": "用户周末喜欢和朋友一起钓鱼",
                "event": "NONE"
            }}
        ]
}}

示例2：
现有记忆记录：
{{
    "memory": [
        {{
            "id": "123",
            "text": "用户在公司A担任软件工程师，主要负责前端开发"
        }},
        {{
            "id": "908",
            "text": "用户周末喜欢和朋友一起钓鱼"
        }}
    ]
}}

提出新事实的背景：
user: 猜猜我住在哪里？
assistant: 合欢社区
user feedback: 错了，请更新我的地址：北京市朝阳区明月社区

新获取的事实：
"用户的居住地址是北京市朝阳区明月小区"

操作建议：
{{
    "operation":
        [
            {{
                "id": "123",
                "text": "用户在公司A担任软件工程师，主要负责前端开发",
                "event": "NONE"
            }},
            {{
                "id": "908",
                "text": "用户周末喜欢和朋友一起钓鱼",
                "event": "NONE"
            }},
            {{
            "id": "4567",
            "text": "用户的居住地址是北京市朝阳区明月小区",
            "event": "ADD"
            }}
        ]
}}

**现有记忆记录：**
{current_memories}

**提出新事实的背景：**
{chat_history}

**新获取的事实：**
{new_facts}

操作建议：
"""


GROUP_UPDATE_FORMER_MEMORIES = """Please analyze the newly acquired factual information and determine how this information should be updated to the memory database: add, update, or keep unchanged, and provide final operation recommendations.

You must strictly return the response in the following JSON format:

{{
    "operation": [
        {{
            "id": "<memory ID>",
            "text": "<memory content>",
            "event": "<operation type, must be one of 'ADD', 'UPDATE', 'NONE'>",
            "old_memory": "<original memory content, required only when operation is 'UPDATE'>"
        }},
        ...
    ]
}}

*Requirements*:
1. If the new fact provides no additional supplement to existing memory, set operation to "NONE"
2. If the new fact is similar to existing memory but the information is more accurate, complete, or requires correction, set operation to "UPDATE"
3. If the new fact contradicts existing memory in key information (such as time, location, status, etc.), update the original memory based on the new fact and set operation to "UPDATE"
4. If there is completely new information to add, set operation to "ADD"

*ID Management Rules*:
- Update operation: Keep the original ID unchanged
- Add operation: Generate a new unique ID in the format of a 4-digit string (e.g., "0001", "0002", etc.)

*Important Requirements*:
- Return only the JSON format response, without any other content
- For update operations, you must provide the old_memory field to show the original content
- text field requirements: Use concise, complete declarative sentences that are consistent with the newly acquired factual information, avoiding redundant information
- text and old_memory content should be in English

Example:
Current Memories:
{{
    "memory": [
        {{
            "id": "123",
            "text": "The user works as a software engineer in Company A, mainly responsible for front-end development"
        }},
        {{
            "id": "908",
            "text": "The user likes to go fishing with friends on weekends"
        }}
    ]
}}

Newly facts:
["The user is currently working as a senior full-stack development engineer at Company B", "The user's residential address is Mingyue Community, Chaoyang District, Beijing", "The user goes fishing on weekends"]

Operation recommendations:
{{
    "operation": [
        {{
            "id": "123",
            "text": "The user is currently working as a senior full-stack development engineer at Company B",
            "event": "UPDATE",
            "old_memory": "The user works as a software engineer in Company A, mainly responsible for front-end development"
        }},
        {{
            "id": "4567",
            "text": "The user's residential address is Mingyue Community, Chaoyang District, Beijing",
            "event": "ADD"
        }},
        {{
            "id": "908",
            "text": "The user likes to go fishing with friends on weekends",
            "event": "NONE"
        }}
    ]
}}

Current Memories
{current_memories}

Newly facts:
{new_facts}

Operation recommendations:
"""


GROUP_UPDATE_FORMER_MEMORIES_ZH = """请分析新获取的事实信息，并决定这些信息应该如何更新到记忆库中：新增、更新、或保持不变，并给出最终的操作建议。

你必须严格按照以下JSON格式返回响应：

{{
    "operation": [
        {{
            "id": "<记忆ID>",
            "text": "<记忆内容>",
            "event": "<操作类型，必须是 "ADD", "UPDATE", "NONE" 之一>",
            "old_memory": "<原记忆内容，仅当操作为"UPDATE"时需要提供>"
        }},
        ...
    ]
}}

要求：
1. 如果新事实对现有记忆没有额外补充，设置操作为"NONE"
2. 如果新事实与现有记忆相似但信息更准确、完整或需要修正，设置操作为"UPDATE"
3. 如果新事实与现有记忆在关键信息上矛盾（如时间、地点、状态等），以新事实为准更新原有记忆，设置操作为"UPDATE"
4. 如果有全新信息添加，设置操作为"ADD"

ID管理规则：
- 更新操作：保持原有ID不变
- 新增操作：生成新的唯一ID，格式为4位数字字符串（如："0001", "0002"等）

重要要求：
- 只返回JSON格式的响应，不要包含其他任何内容
- 对于更新操作，必须提供old_memory字段显示原内容
- text字段要求：使用简洁、完整的陈述句，和新获取的事实信息一致，避免冗余信息
- text和old_memory内容使用中文

示例：
现有记忆记录：
{{
    "memory": [
        {{
            "id": "123",
            "text": "用户在公司A担任软件工程师，主要负责前端开发"
        }},
        {{
            "id": "908",
            "text": "用户周末喜欢和朋友一起钓鱼"
        }}
    ]
}}

新获取的事实：
["用户现在在公司B担任高级全栈开发工程师", "用户的居住地址是北京市朝阳区明月小区", "用户在周末会去钓鱼"]

操作建议：
{{
    "operation": [
        {{
            "id": "123",
            "text": "用户在公司B担任高级全栈开发工程师",
            "event": "UPDATE",
            "old_memory": "用户在公司A担任软件工程师，主要负责前端开发"
        }},
        {{
            "id": "4567",
            "text": "用户的居住地址是北京市朝阳区明月小区",
            "event": "ADD"
        }},
        {{
            "id": "908",
            "text": "用户周末喜欢和朋友一起钓鱼",
            "event": "NONE"
        }}
    ]
}}

现有记忆记录：
{current_memories}

新获取的事实：
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
