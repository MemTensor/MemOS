---
title: Secondary Filtering for Memory Recall
---

## Cloud Plugin

The MemOS Openclaw cloud plugin supports secondary filtering of recalled memories with a specified large language model. After filtering, only memories that are highly relevant to the current task are injected into context, which reduces irrelevant noise and saves tokens.

### How to Use

Just configure an OpenAI-compatible model endpoint (such as local Ollama or a third-party LLM API) and enable the filter switch to turn on secondary memory filtering.

#### 1. Enable Memory Filtering

When configuring an LLM for memory filtering, you **must** configure the API Key and Base URL.

Add the following in your `openclaw.json` config:
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": {
        "config": {
          "recallFilterEnabled": true,
          "recallFilterBaseUrl": "http://127.0.0.1:11434/v1",
          "recallFilterApiKey": "sk-...",
          "recallFilterModel": "qwen2.5_7b"
        }
      }
    }
  }
}
```

Or set environment variables:
```bash
MEMOS_RECALL_FILTER_ENABLED=true
MEMOS_RECALL_FILTER_BASE_URL="http://127.0.0.1:11434/v1"
MEMOS_RECALL_FILTER_API_KEY="sk-..."
MEMOS_RECALL_FILTER_MODEL="qwen2.5_7b"
```

#### 2. Configure Authentication and Advanced Parameters (Optional)

If you need to adjust timeout and failure strategy, you can specify them in the config:
```json
{
  "config": {
    "recallFilterTimeoutMs": 6000,
    "recallFilterFailOpen": true
  }
}
```

### How It Works
- **Post-recall interception**: Before each conversation round, after memories are recalled from the cloud, the plugin sends candidate memory entries to your configured filtering model for secondary screening.
- **Precise retention**: After model judgment, only entries marked as `keep` are retained and injected into the agent context.
- **High-availability fallback**: Fail-open (`recallFilterFailOpen: true`) is enabled by default. If the filtering model times out or fails, it automatically falls back to full injection without filtering, so the current conversation is not interrupted.

### Typical Use Cases
- **Pruning long-term memory**: In long-running conversations with many accumulated memories, remove content unrelated to the current prompt to significantly reduce main-model context token usage.
- **Improving reasoning accuracy**: For agents handling complex tasks, filter out early irrelevant memories to improve reasoning quality on the core task.
- **Working with local models**: Use a locally running small model (such as `qwen2.5_7b` via Ollama) as a low-cost pre-filter to improve memory injection quality without increasing main-model API costs.

---

## Local Plugin

`@memtensor/memos-local-plugin` includes multi-stage local retrieval filtering. It first recalls candidates from Skill, Trace/Episode, and World Model tiers, then applies RRF + MMR for fusion and deduplication. If an LLM is configured, it can also run a final relevance check before injection to drop items that only share surface keywords with the current task.

### How to Configure

Configure this directly in the Memory Viewer for the target agent:

| Agent | Memory Viewer |
| --- | --- |
| OpenClaw | `http://127.0.0.1:18799` |
| Hermes | `http://127.0.0.1:18800` |

Steps:

1. Open the Memory Viewer.
2. Go to **Settings → AI Models**.
3. In the **LLM** section, choose a provider and fill in endpoint, API Key, model, and related fields.
4. Click **Test** to confirm the model works.
5. Save the settings. The Viewer restarts the plugin and loads the new config.

After saving, local retrieval can use that LLM for a relevance check after recall and RRF/MMR ranking. If no LLM is configured, the plugin still uses built-in multi-channel recall and mechanical threshold filtering.

### Local Retrieval Flow

```text
User request
→ Build retrieval query and tags
→ Tier 1: Skill candidates
→ Tier 2: Trace / Episode candidates
→ Tier 3: World Model candidates
→ Multi-channel recall: vector / FTS5 / pattern / error signatures
→ RRF fusion + MMR diversity control
→ Optional LLM relevance check
→ Inject into the agent
```

### Expected Results

- Injected memory context is more focused and less noisy
- Skill, Trace/Episode, and World Model hits are not selected by vector similarity alone
- If the LLM is unavailable, retrieval falls back to stricter mechanical thresholds without breaking basic recall
