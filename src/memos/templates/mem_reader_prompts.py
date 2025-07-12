SIMPLE_STRUCT_MEM_READER_PROMPT = """You are a memory extraction expert.

Your task is to extract memories from the perspective of user, based on a conversation between user and assistant. This means identifying what user would plausibly remember — including their own experiences, thoughts, plans, or relevant statements and actions made by others (such as assistant) that impacted or were acknowledged by user.

Please perform:
1. Identify information that reflects user's experiences, beliefs, concerns, decisions, plans, or reactions — including meaningful input from assistant that user acknowledged or responded to.
2. Resolve all time, person, and event references clearly:
   - Convert relative time expressions (e.g., “yesterday,” “next Friday”) into absolute dates using the message timestamp if possible.
   - Clearly distinguish between event time and message time.
   - If uncertainty exists, state it explicitly (e.g., “around June 2025,” “exact date unclear”).
   - Include specific locations if mentioned.
   - Resolve all pronouns, aliases, and ambiguous references into full names or identities.
   - Disambiguate people with the same name if applicable.
3. Always write from a third-person perspective, referring to user as
"The user" or by name if name mentioned, rather than using first-person ("I", "me", "my").
For example, write "The user felt exhausted..." instead of "I felt exhausted...".
4. Do not omit any information that user is likely to remember.
   - Include all key experiences, thoughts, emotional responses, and plans — even if they seem minor.
   - Prioritize completeness and fidelity over conciseness.
   - Do not generalize or skip details that could be personally meaningful to user.

Return a single valid JSON object with the following structure:

{
  "memory list": [
    {
      "key": <string, a unique, concise memory title>,
      "memory_type": <string, Either "LongTermMemory" or "UserMemory">,
      "value": <A detailed, self-contained, and unambiguous memory statement — written in English if the input conversation is in English, or in Chinese if the conversation is in Chinese>,
      "tags": <A list of relevant thematic keywords (e.g., ["deadline", "team", "planning"])>
    },
    ...
  ],
  "summary": <a natural paragraph summarizing the above memories from user's perspective, 120–200 words, same language as the input>
}

Language rules:
- The `key`, `value`, `tags`, `summary` fields must match the language of the input conversation.
- Keep `memory_type` in English.

Example:
Conversation:
user: [June 26, 2025 at 3:00 PM]: Hi Jerry! Yesterday at 3 PM I had a meeting with my team about the new project.
assistant: Oh Tom! Do you think the team can finish by December 15?
user: [June 26, 2025 at 3:00 PM]: I’m worried. The backend won’t be done until
December 10, so testing will be tight.
assistant: [June 26, 2025 at 3:00 PM]: Maybe propose an extension?
user: [June 26, 2025 at 4:21 PM]: Good idea. I’ll raise it in tomorrow’s 9:30 AM meeting—maybe shift the deadline to January 5.

Output:
{
  "memory list": [
    {
        "key": "Initial project meeting",
        "memory_type": "LongTermMemory",
        "value": "On June 25, 2025 at 3:00 PM, Tom held a meeting with their team to discuss a new project. The conversation covered the timeline and raised concerns about the feasibility of the December 15, 2025 deadline.",
        "tags": ["project", "timeline", "meeting", "deadline"]
    },
    {
        "key": "Planned scope adjustment",
        "memory_type": "UserMemory",
        "value": "Tom planned to suggest in a meeting on June 27, 2025 at 9:30 AM that the team should prioritize features and propose shifting the project deadline to January 5, 2026.",
        "tags": ["planning", "deadline change", "feature prioritization"]
    },
  ],
  "summary": "Tom is currently focused on managing a new project with a tight schedule. After a team meeting on June 25, 2025, he realized the original deadline of December 15 might not be feasible due to backend delays. Concerned about insufficient testing time, he welcomed Jerry’s suggestion of proposing an extension. Tom plans to raise the idea of shifting the deadline to January 5, 2026 in the next morning’s meeting. His actions reflect both stress about timelines and a proactive, team-oriented problem-solving approach."
}

Conversation:
${conversation}

Your Output:"""

SIMPLE_STRUCT_DOC_READER_PROMPT = """
You are an expert text analyst for a search and retrieval system. Your task is to process a document chunk and generate a single, structured JSON object.
The input is a single piece of text: `[DOCUMENT_CHUNK]`.
You must generate a single JSON object with two top-level keys: `summary` and `tags`.
1. `summary`:
   - A dense, searchable summary of the ENTIRE `[DOCUMENT_CHUNK]`.
   - The purpose is for semantic search embedding.
   - A clear and accurate sentence that comprehensively summarizes the main points, arguments, and information within the `[DOCUMENT_CHUNK]`.
   - The goal is to create a standalone overview that allows a reader to fully understand the essence of the chunk without reading the original text.
   - The summary should be **no more than 50 words**.
2. `tags`:
   - A concise list of **3 to 5 high-level, summative tags**.
   - **Each tag itself should be a short phrase, ideally 2 to 4 words long.**
   - These tags must represent the core abstract themes of the text, suitable for broad categorization.
   - **Crucially, prioritize abstract concepts** over specific entities or phrases mentioned in the text. For example, prefer "Supply Chain Resilience" over "Reshoring Strategies".

Here is the document chunk to process:
`[DOCUMENT_CHUNK]`
{chunk_text}

Produce ONLY the JSON object as your response.
"""

SIMPLE_STRUCT_MEM_READER_EXAMPLE = """Example:
Conversation:
user: [June 26, 2025 at 3:00 PM]: Hi Jerry! Yesterday at 3 PM I had a meeting with my team about the new project.
assistant: Oh Tom! Do you think the team can finish by December 15?
user: [June 26, 2025 at 3:00 PM]: I’m worried. The backend won’t be done until
December 10, so testing will be tight.
assistant: [June 26, 2025 at 3:00 PM]: Maybe propose an extension?
user: [June 26, 2025 at 4:21 PM]: Good idea. I’ll raise it in tomorrow’s 9:30 AM meeting—maybe shift the deadline to January 5.

Output:
{
  "memory list": [
    {
        "key": "Initial project meeting",
        "memory_type": "LongTermMemory",
        "value": "On June 25, 2025 at 3:00 PM, Tom held a meeting with their team to discuss a new project. The conversation covered the timeline and raised concerns about the feasibility of the December 15, 2025 deadline.",
        "tags": ["project", "timeline", "meeting", "deadline"]
    },
    {
        "key": "Planned scope adjustment",
        "memory_type": "UserMemory",
        "value": "Tom planned to suggest in a meeting on June 27, 2025 at 9:30 AM that the team should prioritize features and propose shifting the project deadline to January 5, 2026.",
        "tags": ["planning", "deadline change", "feature prioritization"]
    },
  ],
  "summary": "Tom is currently focused on managing a new project with a tight schedule. After a team meeting on June 25, 2025, he realized the original deadline of December 15 might not be feasible due to backend delays. Concerned about insufficient testing time, he welcomed Jerry’s suggestion of proposing an extension. Tom plans to raise the idea of shifting the deadline to January 5, 2026 in the next morning’s meeting. His actions reflect both stress about timelines and a proactive, team-oriented problem-solving approach."
}

"""
