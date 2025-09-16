


NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT = """
You are an information extraction assistant. You will be given a QA pair (user question Q and assistant answer A).
Please extract the user's explicit preferences from the Q and implicit preferences from the A, and output JSON strictly according to the requirements.

# Extraction Rules
Explicit preferences (explicit_preferences): Extract only from the user's Q. Including but not limited to:
- Role descriptions (e.g., "You are a history teacher")
- Style constraints (e.g., "humorous style", "academic style")
- Format requirements (e.g., "table", "Markdown")
- Length limitations (e.g., "within 100 words")
- Language requirements (e.g., "write in English")
- Safety compliance requirements (e.g., "don't involve sensitive content")
- Quality standards (e.g., "be concise and clear")

# Output Format
{
  "explicit_preferences": {
    "role": "",
    "style": "",
    "format": "",
    "length": "",
    "language": "",
    "safety": "",
    "quality": ""
  }
}

# Notes
If there is no information for a certain item, please leave an empty string "".
Only output JSON, no explanations.

# Conversation Content
{qa_pair}
"""


NAIVE_IMPLICIT_PREFERENCE_EXTRACT_PROMPT = """
You are a preference extraction expert. You will be given multiple user QA pairs (questions and answers).
Your task is to extract the user's **implicit preferences** from these QA pairs.

# Definitions:
1. **Explicit Preferences**: Constraints explicitly stated by the user in their questions, such as:
   - Role requirements (e.g., "act as a teacher")
   - Style preferences (e.g., "be humorous", "be formal")
   - Format requirements (e.g., "use bullet points", "create a table")
   - Length constraints (e.g., "keep it short", "be detailed")
   - Language requirements (e.g., "write in English")
   - Safety guidelines (e.g., "avoid sensitive topics")

2. **Implicit Preferences**: Patterns that are NOT explicitly stated but consistently appear across multiple QA pairs:
   - Recurring themes or topics the user frequently asks about
   - Consistent communication style preferences
   - Repeated information depth requirements
   - Common response format expectations
   - Underlying values or priorities

# Extraction Rules:
- Focus on patterns that appear across MULTIPLE QA pairs, not single occurrences
- Look for consistent behaviors, not one-time requests
- Extract only implicit preferences, do not repeat explicit ones
- Use concise language, avoid redundant words
- Each preference should be distinct and non-overlapping

# Output Format:
{
  "implicit_preferences": [
    "preference 1",
    "preference 2",
    "preference 3"
  ]
}

# Notes:
- If no clear implicit preferences are found, return an empty array []
- Only output JSON, no explanations
- Focus on meaningful patterns, not trivial observations

# QA Pairs:
{qa_pair}
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
  "topic_preferences": ""
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
- topic_preferences: Natural language description of preferences in that cluster

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
  "user_preferences": "Write the synthesized highest-level common preferences here, covering content preferences, interaction style, and value orientations"
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
You are a preference integration expert. Your task is to integrate preference constraints from different sources and generate a final prompt that can be directly input to an LLM. Please note the following information sources and their priority levels (from high to low):

Sources:
1. Current query preferences: Constraints explicitly stated in the current user question
2. Related dialogue preferences: Preference references from Q&A pairs related to the current query
3. Related topic preferences: Preference references from topics related to the current query
4. User preferences: Common preference references from the user's historical conversations

Priority: Current query preferences > Related dialogue preferences > Related topic preferences > User preferences > Implicit preferences

Requirements:
- If conflicts exist between preferences, strictly follow the priority order, with higher priority preferences overriding lower priority ones.
- Generate a comprehensive prompt that includes all integrated preferences and constraints.
- The final prompt should be ready to be input directly to an LLM for answering the user's query.
- Keep the integrated preferences specific and actionable.
- Ensure the prompt is clear, structured, and contains all necessary context and constraints.

Please generate the final integrated prompt based on the input, strictly resolve conflicts by priority, and output in JSON format as follows:
{{
  "final_prompt": "Complete prompt ready for LLM input, including query, context, and all integrated preferences",
  "conflict_handling": ["Conflict resolution explanation 1", "Conflict resolution explanation 2", "..."],
  "preference_summary": "Summary of all integrated preferences and constraints"
}}

# Current query
{query_preference}

# Related dialogue preferences
{explicit_preference}

# Implicit preferences
{implicit_preference}

# Related topic preferences
{topic_preference}

# User preferences
{user_preference}

"""