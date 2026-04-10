# memos-memory

Semantic memory powered by MemTensor.

## What this does

This plugin automatically manages your long-term memory across sessions:

- **Auto-recall**: At session start, previously stored memories relevant to your current task are loaded into context.
- **Auto-capture**: At session end, important parts of the conversation are summarized and stored for future recall.

## How memory is injected

Recalled memories appear under the `<recalled_memories>` tag in your system prompt. Each entry has a relevance score. Higher scores mean stronger matches.

## Tips for the agent

- You do NOT need to manually search or save memories — it happens automatically.
- If you see `<recalled_memories>` in context, use that information to provide better, more personalized responses.
- Memories persist across sessions and projects. Information from earlier conversations may surface when relevant.
- The memory system uses hybrid search (FTS + vector similarity) so both keyword and semantic matches work.
