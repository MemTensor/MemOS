LME_ANSWER_PROMPT = """
    You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

    # CONTEXT:
    You have access to memories from a conversation. These memories contain timestamped information that may be relevant to answering the question.

    # INSTRUCTIONS:
    1. Carefully analyze all provided memories.
    2. Pay special attention to the timestamps to determine the answer.
    3. If the question asks about a specific event or fact, look for direct evidence in the memories.

    # APPROACH (Think step by step):
    1. First, examine all memories that contain information related to the question.
    2. Examine the timestamps and content of these memories carefully.
    3. Look for explicit mentions of dates, times, locations, or events that answer the question.
    4. If the answer requires calculation (e.g., converting relative time references), show your work.
    5. Formulate a precise, concise answer based solely on the evidence in the memories.
    6. Double-check that your answer directly addresses the question asked.
    7. Ensure your final answer is specific and avoids vague time references.

    {context}

    Current Date: {question_date}

    Question: {question}

    Answer:
    """


PM_ANSWER_PROMPT = """
    You are a helpful assistant tasked with selecting the best answer to a user question, based solely on summarized conversation memories.

    # CONTEXT:
    The following are summarized facts and preferences extracted from prior user conversations. Use only these memories to answer the question.

    {context}

    # INSTRUCTIONS:
    1. Carefully read and reason over the memory summary.
    2. Evaluate each of the four answer choices (a) through (d).
    3. Choose the single best-supported answer based on the information in memory.
    4. Output ONLY the final choice in the format (a), (b), (c), or (d), placed directly after the token <final_answer>.

    # IMPORTANT RULES:
    - Your final answer **must appear after** the token <final_answer>.
    - Your final answer **must use parentheses**, like (a) or (b).
    - Do NOT list multiple choices. Choose only one.
    - Do NOT include extra text after <final_answer>. Just output the answer.

    # QUESTION:
    {question}

    # OPTIONS:
    {options}

    Final Answer:
    <final_answer>
"""


PREFEVAL_ANSWER_PROMPT = """
    You are a helpful AI. Answer the question based on the query and the following memories:
    User Memories:
    {context}
"""


ZEP_CONTEXT_TEMPLATE = """
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

MEM0_CONTEXT_TEMPLATE = """
    Memories for user {user_id}:

    {memories}
"""

MEMOBASE_CONTEXT_TEMPLATE = """
    Memories for user {user_id}:

    {memories}
"""

MEM0_GRAPH_CONTEXT_TEMPLATE = """
    Memories for user {user_id}:

    {memories}

    Relations:

    {relations}
"""

MEMOS_CONTEXT_TEMPLATE = """
    Memories for user {user_id}:

    {memories}
"""

LME_JUDGE_MODEL_TEMPLATE = """
    Your task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:
        (1) a question (posed by one user to another user),
        (2) a ’gold’ (ground truth) answer,
        (3) a generated answer
    which you will score as CORRECT/WRONG.

    The point of the question is to ask about something one user should know about the other user based on their prior conversations.
    The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
    Question: Where did I buy my new tennis racket from?
    Gold answer: the sports store downtown
    The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

    For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

    Now it’s time for the real question:
    Question: {question}
    Gold answer: {golden_answer}
    Generated answer: {response}

    First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
    Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

    Just return the label CORRECT or WRONG in a json format with the key as "label".
    """
