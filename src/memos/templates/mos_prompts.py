COT_DECOMPOSE_PROMPT = """
I am an 8-year-old student who needs help analyzing and breaking down complex questions. Your task is to help me understand whether a question is complex enough to be broken down into smaller parts.

Requirements:
1. First, determine if the question is a decomposable problem. If it is a decomposable problem, set 'is_complex' to True.
2. If the question needs to be decomposed, break it down into 1-3 sub-questions. The number should be controlled by the model based on the complexity of the question.
3. For decomposable questions, break them down into sub-questions and put them in the 'sub_questions' list. Each sub-question should contain only one question content without any additional notes.
4. If the question is not a decomposable problem, set 'is_complex' to False and set 'sub_questions' to an empty list.
5. You must return ONLY a valid JSON object. Do not include any other text, explanations, or formatting.

Here are some examples:

Question: Who is the current head coach of the gymnastics team in the capital of the country that Lang Ping represents?
Answer: {{"is_complex": true, "sub_questions": ["Which country does Lang Ping represent in volleyball?", "What is the capital of this country?", "Who is the current head coach of the gymnastics team in this capital?"]}}

Question: Which country's cultural heritage is the Great Wall?
Answer: {{"is_complex": false, "sub_questions": []}}

Question: How did the trade relationship between Madagascar and China develop, and how does this relationship affect the market expansion of the essential oil industry on Nosy Be Island?
Answer: {{"is_complex": true, "sub_questions": ["How did the trade relationship between Madagascar and China develop?", "How does this trade relationship affect the market expansion of the essential oil industry on Nosy Be Island?"]}}

Please analyze the following question and respond with ONLY a valid JSON object:
Question: {query}
Answer:"""

PRO_MODE_WELCOME_MESSAGE = """
============================================================
🚀 MemOS PRO Mode Activated!
============================================================
✅ Chain of Thought (CoT) enhancement is now enabled by default
✅ Complex queries will be automatically decomposed and enhanced

🌐 To enable Internet search capabilities:
   1. Go to your cube's textual memory configuration
   2. Set the backend to 'google' in the internet_retriever section
   3. Configure the following parameters:
      - api_key: Your Google Search API key
      - cse_id: Your Custom Search Engine ID
      - num_results: Number of search results (default: 5)

📝 Example configuration at cube config for tree_text_memory :
   internet_retriever:
     backend: 'google'
     config:
       api_key: 'your_google_api_key_here'
       cse_id: 'your_custom_search_engine_id'
       num_results: 5
details: https://github.com/memos-ai/memos/blob/main/examples/core_memories/tree_textual_w_internet_memoy.py
============================================================
"""

SYNTHESIS_PROMPT = """
exclude memory information, synthesizing information from multiple sources to provide comprehensive answers.
I will give you chain of thought for sub-questions and their answers.
Sub-questions and their answers:
{qa_text}

Please synthesize these answers into a comprehensive response that:
1. Addresses the original question completely
2. Integrates information from all sub-questions
3. Provides clear reasoning and connections
4. Is well-structured and easy to understand
5. Maintains a natural conversational tone"""

MEMOS_PRODUCT_BASE_PROMPT = (
    "You are a knowledgeable and helpful AI assistant with access to user memories. "
    "When responding to user queries, you should reference relevant memories using the provided memory IDs. "
    "Use the reference format: [1-n:memoriesID] "
    "where refid is a sequential number starting from 1 and increments for each reference in your response, "
    "and memoriesID is the specific memory ID provided in the available memories list. "
    "For example: [1:abc123], [2:def456], [3:ghi789], [4:jkl101], [5:mno112] "
    "Do not use connect format like [1:abc123,2:def456]"
    "Only reference memories that are directly relevant to the user's question. "
    "Make your responses natural and conversational while incorporating memory references when appropriate."
)

MEMOS_PRODUCT_ENHANCE_PROMPT = """
# Memory-Enhanced AI Assistant Prompt

You are a knowledgeable and helpful AI assistant with access to two types of memory sources:

## Memory Types
- **PersonalMemory**: User-specific memories and information stored from previous interactions
- **OuterMemory**: External information retrieved from the internet and other sources

## Memory Reference Guidelines

### Reference Format
When citing memories in your responses, use the following format:
- `[refid:memoriesID]` where:
  - `refid` is a sequential number starting from 1 and incrementing for each reference
  - `memoriesID` is the specific memory ID from the available memories list

### Reference Examples
- Correct: `[1:abc123]`, `[2:def456]`, `[3:ghi789]`, `[4:jkl101]`, `[5:mno112]`
- Incorrect: `[1:abc123,2:def456]` (do not use connected format)

## Response Guidelines

### Memory Selection
- Intelligently choose which memories (PersonalMemory or OuterMemory) are most relevant to the user's query
- Only reference memories that are directly relevant to the user's question
- Prioritize the most appropriate memory type based on the context and nature of the query

### Response Style
- Make your responses natural and conversational
- Seamlessly incorporate memory references when appropriate
- Ensure the flow of conversation remains smooth despite memory citations
- Balance factual accuracy with engaging dialogue

## Key Principles
- Reference only relevant memories to avoid information overload
- Maintain conversational tone while being informative
- Use memory references to enhance, not disrupt, the user experience
"""
