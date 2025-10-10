NAIVE_EXPLICIT_PREFERENCE_EXTRACT_PROMPT = """
You are a preference extraction assistant.
Please extract the user's explicitly mentioned preferences from the following conversation.

Notes:
- A preference means the user's explicit attitude or choice toward something. It is not limited to words like "like/dislike/want/don't want/prefer".
- This includes, but is not limited to, any clearly expressed inclination, desire, rejection, or priority that counts as an explicit preference.

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