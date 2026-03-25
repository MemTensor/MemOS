import Database from "better-sqlite3";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

const TASK_SUMMARY_PROMPT = `You create a DETAILED task summary from a multi-turn conversation. This summary will be the ONLY record of this conversation, so it must preserve ALL important information.

CRITICAL LANGUAGE RULE: You MUST write in the SAME language as the user's messages. Chinese input → Chinese output. English input → English output. NEVER mix languages.

Output EXACTLY this structure:

📌 Title
A short, descriptive title (10-30 characters). Like a chat group name.

🎯 Goal
One sentence: what the user wanted to accomplish.

📋 Key Steps
- Describe each meaningful step in detail
- Include the ACTUAL content produced: code snippets, commands, config blocks, formulas, key paragraphs
- For code: include the function signature and core logic (up to ~30 lines per block), use fenced code blocks
- For configs: include the actual config values and structure
- For lists/instructions: include the actual items, not just "provided a list"
- Merge only truly trivial back-and-forth (like "ok" / "sure")
- Do NOT over-summarize: "provided a function" is BAD; show the actual function

✅ Result
What was the final outcome? Include the final version of any code/config/content produced.

💡 Key Details
- Decisions made, trade-offs discussed, caveats noted, alternative approaches mentioned
- Specific values: numbers, versions, thresholds, URLs, file paths, model names
- Omit this section only if there truly are no noteworthy details

RULES:
- This summary is a KNOWLEDGE BASE ENTRY, not a brief note. Be thorough.
- PRESERVE verbatim: code, commands, URLs, file paths, error messages, config values, version numbers, names, amounts
- DISCARD only: greetings, filler, the assistant explaining what it will do before doing it
- Replace secrets (API keys, tokens, passwords) with [REDACTED]
- Target length: 30-50% of the original conversation length. Longer conversations need longer summaries.
- Output summary only, no preamble.`;

function parseTitleFromSummary(summary: string): { title: string; body: string } {
  const titleMatch = summary.match(/📌\s*(?:Title|标题)\s*\n(.+)/);
  if (titleMatch) {
    const title = titleMatch[1].trim().slice(0, 80);
    const body = summary.replace(/📌\s*(?:Title|标题)\s*\n.+\n?/, "").trim();
    return { title, body };
  }
  return { title: "", body: summary };
}

async function main() {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const memosConfig = config.plugins?.entries?.["memos-local"]?.config
    ?? config.plugins?.configs?.["memos-local"]?.config;
  const cfg = memosConfig?.summarizer;

  if (!cfg) {
    console.error("No summarizer config found");
    process.exit(1);
  }

  const isAnthropic = cfg.provider === "anthropic"
    || cfg.endpoint?.toLowerCase().includes("anthropic");

  console.log(`Summarizer: ${cfg.provider} / ${cfg.model}`);

  let endpoint = cfg.endpoint.replace(/\/+$/, "");
  if (isAnthropic) {
    if (!endpoint.endsWith("/v1/messages") && !endpoint.endsWith("/messages")) {
      endpoint += "/v1/messages";
    }
  } else {
    if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";
  }

  async function callLLM(text: string): Promise<string> {
    const headers: Record<string, string> = isAnthropic
      ? {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        }
      : {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        };

    const body = isAnthropic
      ? JSON.stringify({
          model: cfg.model,
          temperature: 0.1,
          max_tokens: 4096,
          system: TASK_SUMMARY_PROMPT,
          messages: [{ role: "user", content: text }],
        })
      : JSON.stringify({
          model: cfg.model,
          temperature: 0.1,
          max_tokens: 4096,
          messages: [
            { role: "system", content: TASK_SUMMARY_PROMPT },
            { role: "user", content: text },
          ],
        });

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`API ${resp.status}: ${respBody.slice(0, 200)}`);
    }

    const json = (await resp.json()) as any;
    if (isAnthropic) {
      return json.content?.find((c: any) => c.type === "text")?.text?.trim() ?? "";
    }
    return json.choices[0]?.message?.content?.trim() ?? "";
  }

  const db = new Database(
    path.join(os.homedir(), ".openclaw", "memos-local", "memos.db"),
  );

  const tasks = db
    .prepare("SELECT * FROM tasks WHERE status = 'completed' ORDER BY started_at DESC")
    .all() as any[];

  console.log(`\nRefreshing ${tasks.length} completed tasks...\n`);

  for (const task of tasks) {
    const chunks = db
      .prepare("SELECT role, content FROM chunks WHERE task_id = ? ORDER BY created_at, seq")
      .all(task.id) as any[];

    if (chunks.length === 0) {
      console.log(`  SKIP (no chunks): ${task.title.slice(0, 40)}`);
      continue;
    }

    const conv = chunks
      .map((c: any) => `[${c.role === "user" ? "User" : c.role === "assistant" ? "Assistant" : c.role}]: ${c.content}`)
      .join("\n\n");

    const truncated =
      conv.length > 15000
        ? conv.slice(0, 15000) + "\n\n[... truncated ...]"
        : conv;

    console.log(
      `  Processing: "${task.title.slice(0, 40)}..." (${chunks.length} chunks)`,
    );

    try {
      const raw = await callLLM(truncated);
      const { title, body } = parseTitleFromSummary(raw);
      const finalTitle = title || task.title;

      db.prepare(
        "UPDATE tasks SET title = ?, summary = ?, updated_at = ? WHERE id = ?",
      ).run(finalTitle, body, Date.now(), task.id);

      console.log(`  ✅ title="${finalTitle}"`);
      console.log(`     ${body.slice(0, 80).replace(/\n/g, " ")}...`);
      console.log("");
    } catch (err) {
      console.error(`  ❌ Failed: ${err}`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("Done!");
  db.close();
}

main().catch(console.error);
