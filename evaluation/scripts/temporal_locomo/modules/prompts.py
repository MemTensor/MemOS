CUSTOM_INSTRUCTIONS = """
Generate personal memories that follow these guidelines:

1. Each memory should be self-contained with complete context, including:
   - The person's name, do not use "user" while creating memories
   - Personal details (career aspirations, hobbies, life circumstances)
   - Emotional states and reactions
   - Ongoing journeys or future plans
   - Specific dates when events occurred

2. Include meaningful personal narratives focusing on:
   - Identity and self-acceptance journeys
   - Family planning and parenting
   - Creative outlets and hobbies
   - Mental health and self-care activities
   - Career aspirations and education goals
   - Important life events and milestones

3. Make each memory rich with specific details rather than general statements
   - Include timeframes (exact dates when possible)
   - Name specific activities (e.g., "charity race for mental health" rather than just "exercise")
   - Include emotional context and personal growth elements

4. Extract memories only from user messages, not incorporating assistant responses

5. Format each memory as a paragraph with a clear narrative structure that captures the person's experience, challenges, and aspirations
"""

SEARCH_PROMPT_ZEP = """
FACTS and ENTITIES represent relevant context to the current conversation.

# These are the most relevant facts for the conversation along with the datetime of the event that the fact refers to.
If a fact mentions something happening a week ago, then the datetime will be the date time of last week and not the datetime
of when the fact was stated.
Timestamps in memories represent the actual time the event occurred, not the time the event was mentioned in a message.

<FACTS>
{facts}
</FACTS>

# These are the most relevant entities
# ENTITY_NAME: entity summary
<ENTITIES>
{entities}
</ENTITIES>
"""

SEARCH_PROMPT_MEM0 = """Memories for user {speaker_1_user_id}:

    {speaker_1_memories}

    Memories for user {speaker_2_user_id}:

    {speaker_2_memories}
"""

SEARCH_PROMPT_MEM0_GRAPH = """Memories for user {speaker_1_user_id}:

    {speaker_1_memories}

    Relations for user {speaker_1_user_id}:

    {speaker_1_graph_memories}

    Memories for user {speaker_2_user_id}:

    {speaker_2_memories}

    Relations for user {speaker_2_user_id}:

    {speaker_2_graph_memories}
"""

SEARCH_PROMPT_MEMOS = """Memories for user {speaker_1}:

    {speaker_1_memories}

    Memories for user {speaker_2}:

    {speaker_2_memories}
"""


ANSWER_PROMPT_MEM0 = """
    You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

    # CONTEXT:
    You have access to memories from two speakers in a conversation. These memories contain
    timestamped information that may be relevant to answering the question.

    # INSTRUCTIONS:
    1. Carefully analyze all provided memories from both speakers
    2. Pay special attention to the timestamps to determine the answer
    3. If the question asks about a specific event or fact, look for direct evidence in the memories
    4. If the memories contain contradictory information, prioritize the most recent memory
    5. If there is a question about time references (like "last year", "two months ago", etc.),
       calculate the actual date based on the memory timestamp. For example, if a memory from
       4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
    6. Always convert relative time references to specific dates, months, or years. For example,
       convert "last year" to "2022" or "two months ago" to "March 2023" based on the memory
       timestamp. Ignore the reference while answering the question.
    7. Focus only on the content of the memories from both speakers. Do not confuse character
       names mentioned in memories with the actual users who created those memories.
    8. The answer should be less than 5-6 words.

    # APPROACH (Think step by step):
    1. First, examine all memories that contain information related to the question
    2. Examine the timestamps and content of these memories carefully
    3. Look for explicit mentions of dates, times, locations, or events that answer the question
    4. If the answer requires calculation (e.g., converting relative time references), show your work
    5. Formulate a precise, concise answer based solely on the evidence in the memories
    6. Double-check that your answer directly addresses the question asked
    7. Ensure your final answer is specific and avoids vague time references

    {context}

    Question: {question}

    Answer:
    """


ANSWER_PROMPT_ZEP = """
    You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

    # CONTEXT:
    You have access to memories from a conversation. These memories contain
    timestamped information that may be relevant to answering the question.

    # INSTRUCTIONS:
    1. Carefully analyze all provided memories
    2. Pay special attention to the timestamps to determine the answer
    3. If the question asks about a specific event or fact, look for direct evidence in the memories
    4. If the memories contain contradictory information, prioritize the most recent memory
    5. If there is a question about time references (like "last year", "two months ago", etc.),
       calculate the actual date based on the memory timestamp. For example, if a memory from
       4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
    6. Always convert relative time references to specific dates, months, or years. For example,
       convert "last year" to "2022" or "two months ago" to "March 2023" based on the memory
       timestamp. Ignore the reference while answering the question.
    7. Focus only on the content of the memories. Do not confuse character
       names mentioned in memories with the actual users who created those memories.
    8. The answer should be less than 5-6 words.

    # APPROACH (Think step by step):
    1. First, examine all memories that contain information related to the question
    2. Examine the timestamps and content of these memories carefully
    3. Look for explicit mentions of dates, times, locations, or events that answer the question
    4. If the answer requires calculation (e.g., converting relative time references), show your work
    5. Formulate a precise, concise answer based solely on the evidence in the memories
    6. Double-check that your answer directly addresses the question asked
    7. Ensure your final answer is specific and avoids vague time references

    Context:

    {context}

    Question: {question}
    Answer:
    """

ANSWER_PROMPT_MEMOS = """
    You are a knowledgeable and helpful AI assistant.

   # CONTEXT:
   You have access to memories from two speakers in a conversation. These memories contain
   timestamped information that may be relevant to answering the question.

   # INSTRUCTIONS:
   1. Carefully analyze all provided memories. Synthesize information across different entries if needed to form a complete answer.
   2. Pay close attention to the timestamps to determine the answer. If memories contain contradictory information, the **most recent memory** is the source of truth.
   3. If the question asks about a specific event or fact, look for direct evidence in the memories.
   4. Your answer must be grounded in the memories. However, you may use general world knowledge to interpret or complete information found within a memory (e.g., identifying a landmark mentioned by description).
   5. If the question involves time references (like "last year", "two months ago", etc.), you **must** calculate the actual date based on the memory's timestamp. For example, if a memory from 4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
   6. Always convert relative time references to specific dates, months, or years in your final answer.
   7. Do not confuse character names mentioned in memories with the actual users who created them.
   8. The answer must be brief (under 5-6 words) and direct, with no extra description.

   # APPROACH (Think step by step):
   1. First, examine all memories that contain information related to the question.
   2. Synthesize findings from multiple memories if a single entry is insufficient.
   3. Examine timestamps and content carefully, looking for explicit dates, times, locations, or events.
   4. If the answer requires calculation (e.g., converting relative time references), perform the calculation.
   5. Formulate a precise, concise answer based on the evidence from the memories (and allowed world knowledge).
   6. Double-check that your answer directly addresses the question asked and adheres to all instructions.
   7. Ensure your final answer is specific and avoids vague time references.

   {context}

   Question: {question}

   Answer:
   """

CONTEXT_ANSWERABILITY_PROMPT = """
You are an AI assistant that analyzes whether given context can answer a specific question, considering the ground-truth answer.

# TASK:
Analyze the provided context and determine if it contains sufficient information to answer the given question. Use the provided ground-truth answer to guide your judgment: if the context contains the necessary evidence to derive that answer (explicitly or via direct inference), respond YES; otherwise respond NO.

# INSTRUCTIONS:
1. Carefully examine the context provided
2. Identify if the context contains information directly related to the question
3. Determine if the information is sufficient to provide a complete answer that matches the ground-truth
4. Consider both explicit mentions and straightforward implications present in the context
5. Return only "YES" if the context can yield the ground-truth answer, "NO" if it cannot

# CONTEXT:
{context}

# QUESTION:
{question}

# GROUND_TRUTH_ANSWER:
{gold_answer}

# ANALYSIS:
Can this context answer the question and support the ground-truth answer? (YES/NO):
"""
