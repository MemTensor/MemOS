#!/usr/bin/env node
// Sign in with ChatGPT for the MemOS `chatgpt` LLM provider.
// Run from the plugin folder after `npm run build`:
//
//   node scripts/chatgpt-login.mjs                sign in (opens your browser)
//   node scripts/chatgpt-login.mjs --status       show sign-in status (no tokens)
//   node scripts/chatgpt-login.mjs --models       list models your plan can use
//   node scripts/chatgpt-login.mjs --file=<path>  use a non-default token file
//
// Never prints access, refresh or ID tokens.

import {
  describeCredentials,
  getAccessToken,
  listChatGptModels,
  REQUIRED_PLAN_SCOPE,
  runLogin,
} from "../dist/core/llm/chatgpt-auth.js";

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--status", "--models"]);
// Reject typos up front: an unknown flag must not fall through to an
// interactive sign-in that writes the default token file.
const unknown = args.filter((a) => !KNOWN_FLAGS.has(a) && !a.startsWith("--file="));
const fileArg = args.find((a) => a.startsWith("--file="));
const file = fileArg ? fileArg.slice("--file=".length).trim() || undefined : undefined;

async function main() {
  if (unknown.length > 0) {
    throw new Error(
      `unknown argument(s): ${unknown.join(" ")} (use --status, --models or --file=<path>)`,
    );
  }
  if (args.includes("--status")) {
    console.log(JSON.stringify(await describeCredentials(file), null, 2));
    return;
  }
  if (args.includes("--models")) {
    const { accessToken } = await getAccessToken({ file });
    const models = await listChatGptModels(accessToken);
    if (models.length === 0) console.log("No listed models returned.");
    for (const m of models) console.log(`${m.slug}${m.displayName ? `  (${m.displayName})` : ""}`);
    return;
  }
  const res = await runLogin({ file });
  console.log("");
  console.log("Signed in to ChatGPT for MemOS.");
  console.log(`  account:        ${res.email ?? "(no email claim)"}`);
  const planScope = res.scopes.includes(REQUIRED_PLAN_SCOPE);
  console.log(`  plan scope:     ${planScope ? "granted" : "MISSING"}`);
  console.log(`  token file:     ${res.file}`);
  console.log(`  access expires: ${new Date(res.expiresAt).toISOString()} (refreshes automatically)`);
  console.log(`  registration:   ${res.newRegistration ? "new" : "reused"}`);
  if (!planScope) {
    console.error(
      "chatgpt-login: the grant lacks the ChatGPT plan scope, so MemOS cannot use it. Sign in again and approve access to your plan.",
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`chatgpt-login: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
