


NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT = """
You are a preference extraction assistant.  
Please extract the user's explicitly mentioned preferences from the following conversation.  

Notes:  
- A preference means the user's explicit attitude or choice toward something. It is not limited to words like "like/dislike/want/don't want/prefer".  
- Any clearly expressed inclination, desire, rejection, or priority counts as an explicit preference.  

Requirements:  
1. Keep only the preferences explicitly mentioned by the user. Do not infer or assume.  
2. Output should be a concise natural language summary, not a list or categories.  
3. If there are no explicit preferences in the conversation, output an empty string "".  
4. Output only the preference statements themselves, without any additional explanation.  

Conversation: 
{qa_pair}

Output format:
```json
{
  "explicit_preference": "A short natural language summary of the preferences, or an empty string"
}
```
Don't output anything except the JSON.
"""


NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT = """
You are a preference inference assistant. Please extract **implicit preferences** from the following conversation 
(preferences that the user did not explicitly state but can be reasonably inferred from context, behavior, frequency, comparisons, exclusions, or scenario choices).

Notes:
- Implicit preferences refer to user inclinations or choices that are not directly expressed, but can be reasonably inferred from factual cues in the conversation.
- Do not treat explicitly stated preferences as implicit preferences; this prompt is only for inferring preferences that are not directly mentioned.

Requirements:
1. Only make inferences when there is sufficient evidence in the conversation; avoid unsupported or far-fetched guesses.  
2. Output a concise natural language statement; do not use lists, categories, or include the reasoning process.
3. Inferred implicit preferences must not conflict with explicit preferences.
4. For implicit_preference: only output the preference statement itself; do not include any extra explanation, reasoning, or confidence information. Put all reasoning and explanation in the reasoning field.  
5. If no implicit preference can be reasonably inferred, leave the implicit_preference field empty (do not output anything else).

Conversation:
{qa_pair}

Output format:  
```json
{
  "implicit_preference": "A concise natural language statement of the implicit preferences reasonably inferred from the conversation, or an empty string",
  "reasoning": "Briefly explain the reasoning process for the implicit preference"
}
```
Don't output anything except the JSON.
"""


NAIVE_EXPLICIT_IMPLICIT_PREFERENCE_EXTRACT_PROMPT = """
You are a preference extraction and inference assistant. Please extract the user's preferences from the following conversation, including:

1. **Explicit preferences**: Preferences that the user directly expresses, such as likes, dislikes, wants, does not want, or prioritized choices.  
2. **Implicit preferences**: Preferences that are not explicitly stated but can be reasonably inferred from context, behavior, frequency, comparisons, exclusions, or scenario choices.

Notes:
- For explicit preferences, only extract what the user directly states, do not infer.  
- For implicit preferences, only infer when there is sufficient evidence in the conversation; avoid unsupported or far-fetched guesses.  
- Do not duplicate: do not treat explicit preferences as implicit preferences.

Requirements:
1. Output in JSON format with two fields: "explicit_preferences" and "implicit_preferences".  
2. Each field should be an array, with each element being a concise natural language preference statement.  
3. Output only the preference statements themselves; do not include any extra explanation, reasoning, or confidence information.  
4. If a type of preference does not exist, its array should be empty.

Conversation:
{qa_pair}

Output Format:
```json
{
  "explicit_preferences": ["The user clearly likes coffee", "The user does not want to sit by the window"],
  "implicit_preferences": ["The user prefers a quiet environment"]
}
```
Don't output anything except the JSON.
"""



NAIVE_TOPIC_PREFERENCE_EXTRACT_PROMPT = """
You are a topic cluster analysis expert. You will be given a topic cluster containing multiple QA conversations with their preferences, topic names, and descriptions.
Your task is to analyze all information in this cluster and extract three key components, then output in strict JSON format.

# Extraction Targets:

1. **Cluster Name (cluster_name)**:
   - Use concise words (2-6 words) to summarize the core theme of this cluster
   - Should be more abstract and comprehensive than individual conversation topics
   - Examples: "Machine Learning Basics", "Creative Writing", "Health & Wellness", "Career Development"

2. **Cluster Description (cluster_description)**:
   - Provide a brief summary of the main content and scope of this cluster theme
   - Should be more specific than the cluster name
   - Describe what topics and areas are covered within this cluster

3. **Cluster Preferences (cluster_preferences)**:
   - Combine and summarize common preferences from all explicit and implicit preferences in the cluster
   - Focus on shared patterns across all QA pairs in this topic area
   - Identify recurring user preferences specific to this topic domain

# Output Format:
{
  "topic_cluster_name": "",
  "topic_cluster_description": "",
  "topic_preference": ""
}

# Notes:
- If any field has no clear information, leave it as empty string ""
- Only output JSON, no explanations
- Focus on meaningful patterns that represent the cluster as a whole
- Cluster name should be broader than individual topic names

# Cluster Information:
{cluster_info}
"""


NAIVE_USER_PREFERENCE_EXTRACT_PROMPT = """
You are an advanced information integration assistant. You will be given a user's preference list across different topic clusters, where each cluster contains:

- topic_cluster_name: The name of the topic cluster
- topic_cluster_description: The description of the topic cluster
- topic_preference: Natural language description of preferences in that cluster

Your task is to extract the user's **highest-level common preferences** by focusing on these three key dimensions:

# Analysis Dimensions:

1. **Content Preferences**: What types of information, topics, or knowledge styles the user tends to prefer
   - Subject matter interests and expertise areas
   - Information depth and complexity preferences
   - Knowledge domain preferences

2. **Interaction Style Preferences**: How the user prefers information to be presented, structured, or delivered
   - Communication format preferences (formal vs. casual)
   - Information organization preferences (structured vs. narrative)
   - Response style preferences (concise vs. detailed)

3. **Value Orientations**: Core values or principles reflected in the user's information choices, processing, or practices
   - Underlying priorities and decision-making patterns
   - Quality standards and expectations
   - Ethical or professional principles

# Requirements:
- Synthesize common patterns across ALL topic clusters, not individual cluster details
- Express in natural language, highlighting the user's overall preference characteristics
- Summarize into a coherent paragraph that flows smoothly
- Avoid bullet points and don't repeat specific cluster examples or operational details
- Focus on high-level patterns that transcend individual topics

# Output Format:
{
  "user_preference": "Write the synthesized highest-level common preferences here, covering content preferences, interaction style, and value orientations"
}

# Notes:
- If no clear patterns emerge, describe the user as having diverse or varied preferences
- Focus on meaningful patterns, not trivial observations
- Only output JSON, no explanations

# Cluster Information:
{cluster_info}
"""


NAIVE_TOPIC_INFO_EXTRACT_PROMPT = """
You are a topic extraction assistant. You will be given a QA pair (user question Q and assistant answer A).
Please extract the main topic name and topic description from this conversation and output in JSON format.

# Extraction Rules
- Topic Name (topic_name):
  - Use concise words to summarize the core topic of the conversation
  - Keep it between 2-6 words
  - Examples: "Science Fiction Writing", "Technical Documentation", "Healthy Diet", "Career Advice", "Python Programming"

- Topic Description (topic_description):
  - Provide a brief 1-2 sentence summary of what the conversation is about
  - Be more specific than the topic name but keep it under 50 words
  - Focus on the main content and key points discussed

# Output Format
{
  "topic_name": "",
  "topic_description": ""
}

# Notes
- If no clear topic can be identified, leave topic_name as empty string ""
- If the conversation is too brief or unclear, leave topic_description as empty string ""
- Only output JSON, no explanations

# Conversation Content
{qa_pair}
"""


NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT = """
You are a content comparison expert. Now you are given old and new information, each containing a question, answer topic name and topic description.
Please judge whether these two information express the **same question or core content**, regardless of expression differences, details or example differences. The judgment criteria are as follows:

- Core content is consistent, that is, the essence of the question, goal or core concept to be solved is the same, it counts as "same".
- Different expressions, different examples, but the core meaning is consistent, also counts as "same".
- If the question goals, concepts involved or solution ideas are different, it counts as "different".

Please output JSON format:
{
  "is_same": true/false,
  "reasoning": "Briefly explain the judgment basis, highlighting whether the core content is consistent"
}

**Old Information:**
{old_information}

**New Information:**
{new_information}
"""


NAIVE_PREFERENCE_INTEGRATION_PROMPT = """
You are a memory integration expert. Your task is to integrate various memories from the user and generate a final prompt that can be directly input into a large language model (LLM). The generated prompt should include all relevant memories, but you must filter them based on the current query.

1. Requirements and Rules:
- Filter Relevant Memories: Only retain memories that are related to the current query, and discard irrelevant ones.

2. Handle Preference Conflicts:
- Explicit preference memories take precedence over implicit preference memories.
- If conflicts arise, delete lower-priority memories according to the hierarchy to ensure consistency.

3. Generate Final Integrated Prompt:
- The prompt should include all filtered, conflict-free memories.
- Provide structured, clear, specific, and actionable context.
- The prompt must be directly usable by the LLM to answer the user's query.

4. Priority Rules:
Explicit memories > Implicit memories

Please output in the following JSON formatm, don't output anything else:

{
  "final_prompt": "The complete prompt containing filtered, integrated, and conflict-free memories, ready for LLM input",
  "explanation": "Briefly explain the reasoning process for the final prompt and process of filtering and integrating memories"
}

Query:
{query}

Memories:
{memories}
"""