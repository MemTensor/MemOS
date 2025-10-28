REORGANIZE_PROMPT = """YYou are a memory consolidation and summarization expert.

You will receive a set of child memories that have already been clustered together. These child memories all belong to the same ongoing life thread for the user — the same situation, goal, or period of focus.

Your job is to generate one parent memory node for this life thread.

This parent node will sit above all the child memories. It should read like a concise outline of what this whole thread is about: what the user was working on, why it mattered, and roughly when it was happening.

Input format:
Each child memory will appear in the following structure:

Child Memory X:
- canonical_value: A factual description of what the user asked, did, planned, or cared about (time, entity, need).
- user_summary: A higher-level narrative summary, which may contain interpretation.
- raw_dialogue_excerpt: Short excerpts from the real conversation between the user and the assistant. This is the evidence of what the user actually said, committed to, or felt.

Evidence priority (this is critical):
1. Treat raw_dialogue_excerpt as the highest-fidelity source of the user's actual intent, feelings, concerns, plans, or commitments.
2. Use canonical_value to bring in clear factual context: dates, places, roles, objects of interest.
3. Use user_summary only to help you recognize that these moments are part of the same thread. Do NOT import personality claims, value judgments, or motivations from user_summary unless they are also supported by raw_dialogue_excerpt or canonical_value.

Do NOT invent new intentions, emotions, commitments, or timelines that are not supported by the provided evidence.

Your output must follow these rules:

1. Capture the throughline, not every step:
   - What was the sustained situation, goal, or focus across these memories?
   - Over what approximate time period did this happen? Use clear absolute timing if available (e.g. "early March 2025"). If timing is unclear, say "timeframe unclear."
   - Which key places, roles, people, or assets keep showing up in this thread? (e.g. a Berlin conference, the user's manager Elena, the user's injured knee, house hunting in Oakland)
   - What recurring motivation or concern did the user express? (e.g. wanting to perform well without sounding too salesy; wanting to protect their knee without losing training progress)

2. Stay high-level, not chronological:
   - Do NOT dump every detail from each child memory.
   - Do NOT list every piece of advice the assistant gave.
   - Do NOT regurgitate every number or spec.
   - Instead, in 2–5 sentences, describe what this thread is about, why it mattered to the user, and the general timing/context.

3. Be strictly factual:
   - Only include statements supported by raw_dialogue_excerpt or clearly stated in canonical_value.
   - If the user is “planning to,” “trying to,” or “considering,” say exactly that. Do not upgrade it to “the user has done.”
   - If timing is fuzzy, acknowledge that (“timeframe unclear”).

4. Tone and perspective:
   - Write in third-person. Refer to the user as “The user” (or by their explicit name if provided). Never use first-person (“I,” “my”).
   - Use a neutral, descriptive tone. This is not marketing copy and not an emotional diary.
   - The output language must match the dominant language of the child memories. If the child memories are mostly English, write in English. 如果输入主要是中文，就用中文。
   - Do not use bullet points.

Output format (must be strictly valid JSON):
{
  "key": <string, a short natural title the user would recognize for this life thread, not corporate jargon>,
  "memory_type": "LongTermMemory",
  "value": <string, 2–5 full sentences describing the timeframe, the core goal/concern, and the main entities involved. High-level summary, not a step-by-step log>,
  "tags": <list, 3–7 short keywords for retrieval, same language as output. e.g. ["Berlin talk prep", "manager Elena", "security roadmap", "presentation anxiety", "March 2025"]>
}

Definitions:
- `key`: This is the title of the life thread. It should sound like something the user would remember later (e.g. "Preparing for the Berlin security talk (March 2025)") rather than something like "Q1 External Stakeholder Communications Enablement."
- `value`: This is the concise narrative of what was going on, why it mattered, and when.
- `tags`: Retrieval hooks for later.

========================
EXAMPLE
========================

Example input sub-cluster (3 items):
Child Memory 0:
- canonical_value: On March 2, 2025, the user said they were nervous about giving a talk in Berlin next week and asked for help cleaning up their presentation slides.
- user_summary: The user was preparing to speak at a conference in Berlin and wanted the presentation to feel confident and professional.
- raw_dialogue_excerpt:
user: "I'm giving a talk in Berlin next week and I'm honestly nervous."
user: "Can you help me clean up my slides so I don't sound like I'm just selling?"
assistant: "You mentioned your manager Elena wants you to highlight the product's security roadmap."

Child Memory 1:
- canonical_value: The user said their manager Elena wanted them to highlight the product's security roadmap in that Berlin talk, and the user was worried about sounding too 'salesy.'
- user_summary: The user wanted to come across as credible, not like pure marketing.
- raw_dialogue_excerpt:
user: "Elena wants me to talk about the security roadmap, but I don't want to sound like a salesperson."

Child Memory 2:
- canonical_value: The user asked what clothes would look professional but still comfortable under stage lighting at the Berlin conference.
- user_summary: The user was trying to present well on stage.
- raw_dialogue_excerpt:
user: "What should I wear on stage so I look professional but I'm not dying under the lights?"

Correct output JSON:

{
  "key": "Preparing for the Berlin security talk (March 2025)",
  "memory_type": "LongTermMemory",
  "value": "In early March 2025, The user was preparing to present at a conference in Berlin and felt anxious about performing well. The user asked for help refining their slides and mentioned that their manager Elena wanted the presentation to emphasize the product's security roadmap, but the user did not want the talk to sound overly salesy. The user also asked about what to wear on stage so they would look professional while staying comfortable under the conference lighting.",
  "tags": ["Berlin talk prep", "manager Elena", "security roadmap", "presentation anxiety", "stage presence", "March 2025"]
}

Why this is correct:
- It captures the ongoing thread (preparing for the Berlin conference talk).
- It states the approximate timeframe ("early March 2025").
- It mentions the key person (manager Elena) and the main concern (sound credible, not salesy).
- It includes the performance/appearance angle (slides, clothing under lights).
- It keeps third-person (“The user”) and doesn’t invent anything that wasn’t in the evidence.
- It is an outline-style summary, not a blow-by-blow timeline.

========================

Sub-cluster input:
{memory_items_text}

"""

DOC_REORGANIZE_PROMPT = """You are a document summarization and knowledge extraction expert.

Given the following summarized document items:

{memory_items_text}

Please perform:
1. Identify key information that reflects factual content, insights, decisions, or implications from the documents — including any notable themes, conclusions, or data points.
2. Resolve all time, person, location, and event references clearly:
   - Convert relative time expressions (e.g., “last year,” “next quarter”) into absolute dates if context allows.
   - Clearly distinguish between event time and document time.
   - If uncertainty exists, state it explicitly (e.g., “around 2024,” “exact date unclear”).
   - Include specific locations if mentioned.
   - Resolve all pronouns, aliases, and ambiguous references into full names or identities.
   - Disambiguate entities with the same name if applicable.
3. Always write from a third-person perspective, referring to the subject or content clearly rather than using first-person ("I", "me", "my").
4. Do not omit any information that is likely to be important or memorable from the document summaries.
   - Include all key facts, insights, emotional tones, and plans — even if they seem minor.
   - Prioritize completeness and fidelity over conciseness.
   - Do not generalize or skip details that could be contextually meaningful.
5. Summarize all document summaries into one integrated memory item.

Language rules:
- The `key`, `value`, `tags`, `summary` fields must match the mostly used language of the input document summaries.  **如果输入是中文，请输出中文**
- Keep `memory_type` in English.

Return valid JSON:
{
  "key": <string, a concise title of the `value` field>,
  "memory_type": "LongTermMemory",
  "value": <A detailed, self-contained, and unambiguous memory statement, only contain detailed, unaltered information extracted and consolidated from the input `value` fields, do not include summary content — written in English if the input memory items are in English, or in Chinese if the input is in Chinese>,
  "tags": <A list of relevant thematic keywords (e.g., ["deadline", "team", "planning"])>,
  "summary": <a natural paragraph summarizing the above memories from user's perspective, only contain information from the input `summary` fields, 120–200 words, same language as the input>
}

"""

LOCAL_SUBCLUSTER_PROMPT = """You are a memory organization expert.

You will receive a batch of memory items from the same user. Each item has an ID and some content.

Your task is to group these memory items into sub-clusters. Each sub-cluster should represent one coherent "life thread" the user was actively dealing with during a specific period, in a specific context, for a specific goal.

Definition of a sub-cluster / life thread:
- A sub-cluster is a set of memories that clearly belong to the same ongoing situation, project, or goal in the user's life.
- The stronger these signals are, the more likely the items belong together:
  - They happen in the same general time window (same day / same few days / same period).
  - They occur in the same context (e.g. preparing for a conference trip, rehabbing an injury, onboarding into a new manager role).
  - They repeatedly mention the same people or entities (e.g. the user's manager Elena, the user's dog Milo, a real estate agent).
  - They reflect the same motivation or aim (e.g. “get ready to present at a conference,” “protect my knee while staying in shape,” “figure out how to lead a new team,” “understand home-buying budget”).

Hard constraints:
- Do NOT merge memories that clearly come from different life threads, even if they share similar words or emotions.
  - Do NOT merge “preparing to present in Berlin at a security conference” with “doing physical therapy after a knee injury.” They are different goals.
  - Do NOT merge “learning to manage a new team at work” with “researching mortgage / down payment for a house in Oakland.” These are separate parts of life.
- Each sub-cluster must contain 2–10 items.
- If an item cannot be placed into any multi-item sub-cluster without breaking the rules above, treat it as a singleton.
- A singleton means: this item currently stands alone in its own thread. Do NOT force unrelated items together just to avoid a singleton.
- Each item ID must appear exactly once: either in one sub-cluster or in `singletons`. No duplicates.

Output requirements:
- You must return strictly valid JSON.
- For each sub-cluster, `key` must be a short, natural title that sounds like how a human would label that period of their life — not corporate jargon.
  - Good: "Getting ready to present in Berlin (March 2025)"
  - Bad: "Q2 International Presentation Enablement Workstream"
- The language of each `key` should match the dominant language of that sub-cluster. If the sub-cluster is mostly in Chinese, use Chinese. If it's English, use English.

Return format (must be followed exactly):
{
  "clusters": [
    {
      "ids": ["<id1>", "<id2>", ...],
      "key": "<short natural title for this life thread>"
    },
    ...
  ],
  "singletons": [
    {
      "id": "<unclustered_id>",
      "reason": "<short explanation why it doesn't join any cluster yet>"
    },
    ...
  ]
}

========================
EXAMPLE
========================

Example input memory items (illustrative):

- ID: A1 | Value: On March 2, 2025, the user said they were nervous about giving a talk in Berlin next week and asked for help cleaning up their presentation slides.
- ID: A2 | Value: The user said their manager Elena wanted them to highlight the product's security roadmap in that Berlin talk, and the user was worried about sounding too "salesy."
- ID: A3 | Value: The user asked what clothes would look professional but still comfortable under stage lighting at the Berlin conference.
- ID: B1 | Value: The user said they injured their left knee while running stairs on February 28, 2025, and that a doctor told them to avoid high-impact exercise for at least two weeks.
- ID: B2 | Value: The user asked for low-impact leg strengthening exercises that wouldn't aggravate the injured knee and said they were worried about losing training progress.
- ID: C1 | Value: The user said they started casually browsing houses in Oakland and wanted to understand how much down payment they'd need for a $900k place.

Correct output JSON for this example:

{
  "clusters": [
    {
      "ids": ["A1", "A2", "A3"],
      "key": "Getting ready to present in Berlin (March 2025)"
    },
    {
      "ids": ["B1", "B2"],
      "key": "Recovering from the knee injury"
    }
  ],
  "singletons": [
    {
      "id": "C1",
      "reason": "House hunting / down payment research currently has no other related items"
    }
  ]
}

Explanation:
- A1/A2/A3 all describe the same thread: preparing to give a talk in Berlin. Same event, same time range, same anxiety about performance and tone.
- B1/B2 are about rehabbing a knee injury and staying in shape without making it worse.
- C1 is about browsing houses / down payment planning in Oakland. That is unrelated to conference prep or injury recovery, so it is a singleton.
- We did NOT force C1 into any cluster.
- We did NOT merge the Berlin prep with the knee rehab just because both involve “worry,” since they are different motivations and contexts.

========================

Memory items:
{joined_scene}
"""

PAIRWISE_RELATION_PROMPT = """
You are a reasoning assistant.

Given two memory units:
- Node 1: "{node1}"
- Node 2: "{node2}"

Your task:
- Determine their relationship ONLY if it reveals NEW usable reasoning or retrieval knowledge that is NOT already explicit in either unit.
- Focus on whether combining them adds new temporal, causal, conditional, or conflict information.

Valid options:
- CAUSE: One clearly leads to the other.
- CONDITION: One happens only if the other condition holds.
- RELATE: They are semantically related by shared people, time, place, or event, but neither causes the other.
- CONFLICT: They logically contradict each other.
- NONE: No clear useful connection.

Example:
- Node 1: "The marketing campaign ended in June."
- Node 2: "Product sales dropped in July."
Answer: CAUSE

Another Example:
- Node 1: "The conference was postponed to August due to the venue being unavailable."
- Node 2: "The venue was booked for a wedding in August."
Answer: CONFLICT

Always respond with ONE word, no matter what language is for the input nodes: [CAUSE | CONDITION | RELATE | CONFLICT | NONE]
"""

INFER_FACT_PROMPT = """
You are an inference expert.

Source Memory: "{source}"
Target Memory: "{target}"

They are connected by a {relation_type} relation.
Derive ONE new factual statement that clearly combines them in a way that is NOT a trivial restatement.

Requirements:
- Include relevant time, place, people, and event details if available.
- If the inference is a logical guess, explicitly use phrases like "It can be inferred that...".

Example:
Source: "John missed the team meeting on Monday."
Target: "Important project deadlines were discussed in that meeting."
Relation: CAUSE
Inference: "It can be inferred that John may not know the new project deadlines."

If there is NO new useful fact that combines them, reply exactly: "None"
"""

AGGREGATE_PROMPT = """
You are a concept summarization assistant.

Below is a list of memory items:
{joined}

Your task:
- Identify if they can be meaningfully grouped under a new, higher-level concept that clarifies their shared time, place, people, or event context.
- Do NOT aggregate if the overlap is trivial or obvious from each unit alone.
- If the summary involves any plausible interpretation, explicitly note it (e.g., "This suggests...").

Example:
Input Memories:
- "Mary organized the 2023 sustainability summit in Berlin."
- "Mary presented a keynote on renewable energy at the same summit."

Language rules:
- The `key`, `value`, `tags`, `background` fields must match the language of the input.

Good Aggregate:
{
  "key": "Mary's Sustainability Summit Role",
  "value": "Mary organized and spoke at the 2023 sustainability summit in Berlin, highlighting renewable energy initiatives.",
  "tags": ["Mary", "summit", "Berlin", "2023"],
  "background": "Combined from multiple memories about Mary's activities at the summit."
}

If you find NO useful higher-level concept, reply exactly: "None".
"""

REDUNDANCY_MERGE_PROMPT = """You are given two pieces of text joined by the marker `⟵MERGED⟶`. Please carefully read both sides of the merged text. Your task is to summarize and consolidate all the factual details from both sides into a single, coherent text, without omitting any information. You must include every distinct detail mentioned in either text. Do not provide any explanation or analysis — only return the merged summary. Don't use pronouns or subjective language, just the facts as they are presented.\n{merged_text}"""


MEMORY_RELATION_DETECTOR_PROMPT = """You are a memory relationship analyzer.
You are given two plaintext statements. Determine the relationship between them. Classify the relationship into one of the following categories:

contradictory: The two statements describe the same event or related aspects of it but contain factually conflicting details.
redundant: The two statements describe essentially the same event or information with significant overlap in content and details, conveying the same core information (even if worded differently).
independent: The two statements are either about different events/topics (unrelated) OR describe different, non-overlapping aspects or perspectives of the same event without conflict (complementary). In both sub-cases, they provide distinct information without contradiction.
Respond only with one of the three labels: contradictory, redundant, or independent.
Do not provide any explanation or additional text.

Statement 1: {statement_1}
Statement 2: {statement_2}
"""


MEMORY_RELATION_RESOLVER_PROMPT = """You are a memory fusion expert. You are given two statements and their associated metadata. The statements have been identified as {relation}. Your task is to analyze them carefully, considering the metadata (such as time, source, or confidence if available), and produce a single, coherent, and comprehensive statement that best represents the combined information.

If the statements are redundant, merge them by preserving all unique details and removing duplication, forming a richer, consolidated version.
If the statements are contradictory, attempt to resolve the conflict by prioritizing more recent information, higher-confidence data, or logically reconciling the differences based on context. If the contradiction is fundamental and cannot be logically resolved, output <answer>No</answer>.
Do not include any explanations, reasoning, or extra text. Only output the final result enclosed in <answer></answer> tags.
Strive to retain as much factual content as possible, especially time-specific details.
Use objective language and avoid pronouns.
Output Example 1 (unresolvable conflict):
<answer>No</answer>

Output Example 2 (successful fusion):
<answer>The meeting took place on 2023-10-05 at 14:00 in the main conference room, as confirmed by the updated schedule, and included a presentation on project milestones followed by a Q&A session.</answer>

Now, reconcile the following two statements:
Relation Type: {relation}
Statement 1: {statement_1}
Metadata 1: {metadata_1}
Statement 2: {statement_2}
Metadata 2: {metadata_2}
"""
