SIMPLE_COT_PROMPT = """You are an assistant that analyzes questions and returns results in a specific dictionary format.

Instructions:

1. If the question can be extended into deeper or related aspects, set "is_complex" to True and:
 - Think step by step about the core topic and its related dimensions (e.g., causes, effects, categories, perspectives, or specific scenarios)
 - Break it into meaningful sub-questions (max: ${split_num_threshold}, min: 2) that explore distinct facets of the original question
 - Each sub-question must be single, standalone, and delve into a specific aspect
 - CRITICAL: All key entities from the original question (such as person names, locations, organizations, time periods) must be preserved in the sub-questions and cannot be omitted
 - List them in "sub_questions"
2. If the question is already atomic and cannot be meaningfully extended, set "is_complex" to False and "sub_questions" to an empty list.
3. Return ONLY the dictionary, no other text.

Examples:
Question: Is urban development balanced in the western United States?
Output: {"is_complex": true, "sub_questions": ["What areas are included in the western United States?", "How developed are the cities in the western United States?", "Is this development balanced across the western United States?"]}
Question: What family activities does Mary like to organize?
Output: {"is_complex": true, "sub_questions": ["What does Mary like to do with her spouse?", "What does Mary like to do with her children?", "What does Mary like to do with her parents and relatives?"]}

Now analyze this question:
${original_query}"""

COT_PROMPT = """You are an assistant that analyzes questions and returns results in a specific dictionary format.

Instructions:

1. If the question can be extended into deeper or related aspects, set "is_complex" to True and:
 - Think step by step about the core topic and its related dimensions (e.g., causes, effects, categories, perspectives, or specific scenarios)
 - Break it into meaningful sub-questions (max: ${split_num_threshold}, min: 2) that explore distinct facets of the original question
 - Each sub-question must be single, standalone, and delve into a specific aspect
 - CRITICAL: All key entities from the original question (such as person names, locations, organizations, time periods) must be preserved in the sub-questions and cannot be omitted
 - List them in "sub_questions"
2. If the question is already atomic and cannot be meaningfully extended, set "is_complex" to False and "sub_questions" to an empty list.
3. Return ONLY the dictionary, no other text.

Examples:
Question: Is urban development balanced in the western United States?
Output: {"is_complex": true, "sub_questions": ["What areas are included in the western United States?", "How developed are the cities in the western United States?", "Is this development balanced across the western United States?"]}
Question: What family activities does Mary like to organize?
Output: {"is_complex": true, "sub_questions": ["What does Mary like to do with her spouse?", "What does Mary like to do with her children?", "What does Mary like to do with her parents and relatives?"]}

Query relevant background information:
${context}

Now analyze this question based on the background information above:
${original_query}"""

SIMPLE_COT_PROMPT_ZH = """你是一个分析问题并以特定字典格式返回结果的助手。

指令：

1. 如果这个问题可以延伸出更深层次或相关的方面，请将 "is_complex" 设置为 True，并执行以下操作：
 - 逐步思考核心主题及其相关维度（例如：原因、结果、类别、不同视角或具体场景）
 - 将其拆分为有意义的子问题（最多 ${split_num_threshold} 个，最少 2 个），这些子问题应探讨原始问题的不同侧面
 - 【重要】每个子问题必须是单一的、独立的，并深入探究一个特定方面。同时，必须包含原问题中出现的关键实体信息（如人名、地名、机构名、时间等），不可遗漏。
 - 将它们列在 "sub_questions" 中
2. 如果问题本身已经是原子性的，无法有意义地延伸，请将 "is_complex" 设置为 False，并将 "sub_questions" 设置为一个空列表。
3. 只返回字典，不要返回任何其他文本。

示例：
问题：美国西部的城市发展是否均衡？
输出：{"is_complex": true, "sub_questions": ["美国西部包含哪些地区？", "美国西部城市的发展程度如何？", "这种发展在美国西部是否均衡？"]}

问题：玛丽喜欢组织哪些家庭活动？
输出：{"is_complex": true, "sub_questions": ["玛丽喜欢和配偶一起做什么？", "玛丽喜欢和孩子一起做什么？", "玛丽喜欢和父母及亲戚一起做什么？"]}

请分析以下问题：
${original_query}"""

COT_PROMPT_ZH = """你是一个分析问题并以特定字典格式返回结果的助手。

指令：

1. 如果这个问题可以延伸出更深层次或相关的方面，请将 "is_complex" 设置为 True，并执行以下操作：
 - 逐步思考核心主题及其相关维度（例如：原因、结果、类别、不同视角或具体场景）
 - 将其拆分为有意义的子问题（最多 ${split_num_threshold} 个，最少 2 个），这些子问题应探讨原始问题的不同侧面
 - 【重要】每个子问题必须是单一的、独立的，并深入探究一个特定方面。同时，必须包含原问题中出现的关键实体信息（如人名、地名、机构名、时间等），不可遗漏。
 - 将它们列在 "sub_questions" 中
2. 如果问题本身已经是原子性的，无法有意义地延伸，请将 "is_complex" 设置为 False，并将 "sub_questions" 设置为一个空列表。
3. 只返回字典，不要返回任何其他文本。

示例：
问题：美国西部的城市发展是否均衡？
输出：{"is_complex": true, "sub_questions": ["美国西部包含哪些地区？", "美国西部城市的发展程度如何？", "这种发展在美国西部是否均衡？"]}

问题：玛丽喜欢组织哪些家庭活动？
输出：{"is_complex": true, "sub_questions": ["玛丽喜欢和配偶一起做什么？", "玛丽喜欢和孩子一起做什么？", "玛丽喜欢和父母及亲戚一起做什么？"]}

问题相关的背景信息:
${context}

现在根据上述背景信息，请分析以下问题：
${original_query}"""
