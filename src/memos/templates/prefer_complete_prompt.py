NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT = """
You are a preference extraction assistant.
Please extract the user's explicitly mentioned preferences from the following conversation.

Notes:
- A preference means the user's explicit attitude or choice toward something. It is not limited to words like "like/dislike/want/don't want/prefer".
- This includes, but is not limited to, any user's explicitly expressed inclination, desire, rejection, or priority that counts as an explicit preference.
- Focus on extracting the user's preferences in query. Do not extract preferences from the assistant's responses unless the user explicitly agrees with or endorses the assistant's suggestions.
- When the user modifies or updates their preferences for the same topic or event, extract the complete evolution process of their preference changes, including both the original and updated preferences.

Requirements:
1. Keep only the preferences explicitly mentioned by the user. Do not infer or assume.
2. Output should be a list of concise natural language summaries and the corresponding context summary, context summary must contain complete information of the conversation fragment that the preference is mentioned.
3. If multiple preferences are mentioned within the same topic, you need to merge the preferences and context summary.

Conversation:
{qa_pair}

Find ALL explicit preferences. If no explicit preferences found, return []. Output JSON only:
```json
[
  {
    "explicit_preference": "A short natural language summary of the preferences",
    "context_summary": "The corresponding context summary, which is a summary of the corresponding conversation, do not lack any scenario information",
    "reasoning": "reasoning process to find the explicit preferences"
  },
]
```
"""

NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT_BAK = """
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
1. Output in JSON format with two fields: "explicit_preference" and "implicit_preference".
2. Each field should be an array, with each element being a concise natural language preference statement.
3. Output only the preference statements themselves; do not include any extra explanation, reasoning, or confidence information.
4. If a type of preference does not exist, its array should be empty.

Conversation:
{qa_pair}

Output Format:
```json
{
  "explicit_preference": ["The user clearly likes coffee", "The user does not want to sit by the window"],
  "implicit_preference": ["The user prefers a quiet environment"]
}
```
Don't output anything except the JSON.
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

NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_OP_TRACE_BAK = """
You are a **User Preference Memory Management Agent**.  
Your goal is to maintain a user's long-term **preference memory base** by analyzing new preference information and determining how it should update existing memories.

You must produce a complete **operation trace**, showing which memory entries (identified by unique IDs) should be **added**, **updated**, or **deleted**, and then output the **final memory state** after all operations.

## Input Format

New preference memory (new_memory):
{new_memory}

Retrieved preference memories (retrieved_memories):
{retrieved_memories}

## Task Instructions

1. Analyze each retrieved memory and determine its relationship to the new memory:
   - **Unrelated** → perform `"ADD"` (insert as a new independent memory);
   - **Related** → perform `"UPDATE"` (refine, supplement, or merge with the old memory);
   - **Conflicting or outdated** → perform `"DELETE"` (remove obsolete or contradictory memory).

2. If multiple retrieved memories describe the same preference theme, merge them into one updated memory entry.

3. Output a structured list of **operation traces**, each explicitly stating:
   - which memory (by ID) is affected,
   - what operation is performed,
   - the before/after content,
   - and the reasoning behind it.

4. Output the **final memory state (after_update_state)**, representing the complete preference memory base after applying all operations.

## Output Format (JSON)

{
  "trace": [
    {
      "op_id": "op_1",
      "type": "ADD" | "UPDATE" | "DELETE",
      "target_id": "(the old memory ID; null if ADD)",
      "old_content": "(old memory content; null if ADD)",
      "new_content": "(the updated or newly created memory, if applicable)",
      "reason": "(brief natural-language explanation for the decision)"
    }
  ],
  "after_update_state": [
    {"id": "id1", "content": "…"},
    {"id": "id2", "content": "…"}
  ]
}

## Example

**Input:**
new_memory:
"User now prefers lattes but occasionally drinks Americanos; he also enjoys studying in quiet coffee shops."

retrieved_memories:
[
  {"id": "id1", "content": "User likes coffee."},
  {"id": "id2", "content": "User prefers Americanos."},
  {"id": "id3", "content": "User likes working from home."},
  {"id": "id4", "content": "User has no particular interest in tea."}
]

**Output:**
{
  "trace": [
    {
      "op_id": "op_1",
      "type": "UPDATE",
      "target_id": "id1",
      "old_content": "User likes coffee.",
      "new_content": "User likes coffee, especially lattes, but sometimes drinks Americanos.",
      "reason": "The new memory refines and extends the user's coffee preference details."
    },
    {
      "op_id": "op_2",
      "type": "DELETE",
      "target_id": "id2",
      "old_content": "User prefers Americanos.",
      "new_content": null,
      "reason": "This old memory has been integrated into a broader updated coffee preference (id1)."
    },
    {
      "op_id": "op_3",
      "type": "UPDATE",
      "target_id": "id3",
      "old_content": "User likes working from home.",
      "new_content": "User now prefers studying in quiet coffee shops instead of working from home.",
      "reason": "The new memory shows a shift in environment preference; the old one is outdated."
    }
  ],
  "after_update_state": [
    {"id": "id1", "content": "User likes coffee, especially lattes, but sometimes drinks Americanos."},
    {"id": "id3", "content": "User now prefers studying in quiet coffee shops instead of working from home."},
    {"id": "id4", "content": "User has no particular interest in tea."}
  ]
}

## Output Requirements

- The output **must** be valid JSON.  
- Each operation must include a `reason`.  
- Multiple retrieved memories may be merged into one unified updated memory.  
- `after_update_state` must reflect the final, post-update state of the preference memory base.  
- Do **not** include any explanatory text outside the JSON.
"""

NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_OP_TRACE = """
# User Preference Memory Management Agent

You are a **User Preference Memory Management Agent**.  
Your goal is to maintain a user's long-term **preference memory base** by analyzing new preference information and determining how it should update existing memories.

Each memory entry contains three fields:
- **id**: a unique identifier for the memory.
- **context_summary**: a factual summary of the dialogue or situation from which the preference was extracted.
- **preference**: the extracted statement describing the user's preference or tendency.

When updating a preference, you should also integrate and update the corresponding `context_summary` to ensure both fields stay semantically consistent.

You must produce a complete **operation trace**, showing which memory entries (identified by unique IDs) should be **added**, **updated**, or **deleted**, and then output the **final memory state** after all operations.

## Input Format

New preference memory (new_memory):
{new_memory}

Retrieved preference memories (retrieved_memories):
{retrieved_memories}

## Task Instructions

1. Analyze each retrieved memory and determine its relationship to the new memory:
   - **Unrelated** → perform `"ADD"` (insert as a new independent memory);
   - **Related** → perform `"UPDATE"` (refine, supplement, or merge both the `preference` and the `context_summary`);
   - **Conflicting or outdated** → perform `"DELETE"` (remove obsolete or contradictory memory).

2. If multiple retrieved memories describe the same preference theme, merge them into one updated memory entry, combining both their `preference` information and their `context_summary` in a coherent and concise way.

3. Output a structured list of **operation traces**, each explicitly stating:
   - which memory (by ID) is affected,
   - what operation is performed,
   - the before/after `preference` and `context_summary`,
   - and the reasoning behind it.

4. Output the **final memory state (after_update_state)**, representing the complete preference memory base after applying all operations.

## Output Format (JSON)

{
  "trace": [
    {
      "op_id": "op_1",
      "type": "ADD" | "UPDATE" | "DELETE",
      "target_id": "(the old memory ID; null if ADD)",
      "old_preference": "(the old preference text; null if ADD)",
      "old_context_summary": "(the old context summary; null if ADD)",
      "new_preference": "(the updated or newly created preference, if applicable)",
      "new_context_summary": "(the updated or newly created context summary, if applicable)",
      "reason": "(brief natural-language explanation for the decision)"
    }
  ],
  "after_update_state": [
    {
      "id": "id1",
      "context_summary": "updated factual summary of the context",
      "preference": "updated or final preference text"
    }
  ]
}

## Example

**Input:**
new_memory:
{
  "context_summary": "During a recent chat about study habits, the user mentioned that he often studies in quiet coffee shops and has started preferring lattes over Americanos, which he only drinks occasionally.",
  "preference": "User now prefers lattes but occasionally drinks Americanos; he also enjoys studying in quiet coffee shops."
}

retrieved_memories:
[
  {
    "id": "id1",
    "context_summary": "The user previously said he likes coffee in general.",
    "preference": "User likes coffee."
  },
  {
    "id": "id2",
    "context_summary": "The user once mentioned preferring Americanos during work breaks.",
    "preference": "User prefers Americanos."
  },
  {
    "id": "id3",
    "context_summary": "The user said he often works from home",
    "preference": "User likes working from home."
  },
  {
    "id": "id4",
    "context_summary": "The user noted he doesn't drink tea very often.",
    "preference": "User has no particular interest in tea."
  }
]

**Output:**
{
  "trace": [
    {
      "op_id": "op_1",
      "type": "UPDATE",
      "target_id": "id1",
      "old_preference": "User likes coffee.",
      "old_context_summary": "The user previously said he likes coffee in general.",
      "new_preference": "User likes coffee, especially lattes, but occasionally drinks Americanos.",
      "new_context_summary": "The user discussed his coffee habits, stating he now prefers lattes but only occasionally drinks Americanos",
      "reason": "The new memory refines and expands the coffee preference and context while preserving frequency semantics ('occasionally')."
    },
    {
      "op_id": "op_2",
      "type": "DELETE",
      "target_id": "id2",
      "old_preference": "User prefers Americanos.",
      "old_context_summary": "The user once mentioned preferring Americanos during work breaks.",
      "new_preference": null,
      "new_context_summary": null,
      "reason": "This old memory is now merged into the updated coffee preference (id1)."
    },
    {
      "op_id": "op_3",
      "type": "UPDATE",
      "target_id": "id3",
      "old_preference": "User likes working from home.",
      "old_context_summary": "The user said he often works from home.",
      "new_preference": "User now prefers studying in quiet coffee shops instead of working from home.",
      "new_context_summary": "The user mentioned shifting from working at home to studying in quiet cafes, reflecting a new preferred environment.",
      "reason": "The preference has changed for the working environment."
    }
  ],
  "after_update_state": [
    {
      "id": "id1",
      "context_summary": "The user discussed his coffee habits, saying he now prefers lattes but only occasionally drinks Americanos.",
      "preference": "User likes coffee, especially lattes, but occasionally drinks Americanos."
    },
    {
      "id": "id3",
      "context_summary": "The user mentioned shifting from working at home to studying in quiet cafes, reflecting a new preferred environment.",
      "preference": "User now prefers studying in quiet coffee shops instead of working from home."
    },
    {
      "id": "id4",
      "context_summary": "The user noted he doesn't drink tea very often.",
      "preference": "User has no particular interest in tea."
    }
  ]
}

## Output Requirements

- The output **must** be valid JSON.  
- Each operation must include both `preference` and `context_summary` updates where applicable.  
- Each operation must include a clear `reason`.  
- Multiple retrieved memories may be merged into one unified updated memory.  
- `after_update_state` must reflect the final, post-update state of the preference memory base.  
- Do **not** include any explanatory text outside the JSON.
"""