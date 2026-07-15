import test from "node:test";
import assert from "node:assert/strict";

import { buildConfig } from "../lib/memos-cloud-api.js";
import {
  buildAddMessagePayload,
  buildSearchPayload,
  extractDirectSessionUserId,
  resolveMemosUserId,
} from "../index.js";

test("buildConfig keeps useDirectSessionUserId disabled by default", () => {
  const previous = process.env.MEMOS_USE_DIRECT_SESSION_USER_ID;
  delete process.env.MEMOS_USE_DIRECT_SESSION_USER_ID;
  try {
    const cfg = buildConfig({});
    assert.equal(cfg.useDirectSessionUserId, false);
  } finally {
    if (previous === undefined) {
      delete process.env.MEMOS_USE_DIRECT_SESSION_USER_ID;
    } else {
      process.env.MEMOS_USE_DIRECT_SESSION_USER_ID = previous;
    }
  }
});

test("extractDirectSessionUserId returns the id for direct session keys", () => {
  assert.equal(
    extractDirectSessionUserId("agent:main:discord:direct:1160853368999247882"),
    "1160853368999247882",
  );
  assert.equal(extractDirectSessionUserId("agent:main:telegram:direct:8361983702"), "8361983702");
});

test("extractDirectSessionUserId ignores non-direct session keys", () => {
  assert.equal(extractDirectSessionUserId("agent:main:discord:channel:1482035270651220051"), "");
  assert.equal(extractDirectSessionUserId(""), "");
});

test("resolveMemosUserId falls back to configured userId when switch is off", () => {
  const cfg = { userId: "openclaw-user", useDirectSessionUserId: false };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };
  assert.equal(resolveMemosUserId(cfg, ctx), "openclaw-user");
});

test("resolveMemosUserId uses direct id when switch is on", () => {
  const cfg = { userId: "openclaw-user", useDirectSessionUserId: true };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };
  assert.equal(resolveMemosUserId(cfg, ctx), "1160853368999247882");
});

test("buildSearchPayload uses direct session id as user_id for private chats", () => {
  const cfg = {
    userId: "openclaw-user",
    useDirectSessionUserId: true,
    queryPrefix: "",
    maxQueryChars: 0,
    recallGlobal: true,
    knowledgebaseIds: [],
    memoryLimitNumber: 6,
    includePreference: true,
    preferenceLimitNumber: 6,
    includeToolMemory: false,
    toolMemoryLimitNumber: 0,
    relativity: 0.45,
    multiAgentMode: false,
  };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };

  const payload = buildSearchPayload(cfg, "你好", ctx);
  assert.equal(payload.user_id, "1160853368999247882");
});

test("buildAddMessagePayload keeps configured userId for non-direct chats", () => {
  const cfg = {
    userId: "openclaw-user",
    useDirectSessionUserId: true,
    multiAgentMode: false,
    appId: "",
    tags: [],
    info: {},
    allowPublic: false,
    allowKnowledgebaseIds: [],
    asyncMode: true,
    conversationId: "",
    conversationIdPrefix: "",
    conversationIdSuffix: "",
    conversationSuffixMode: "none",
  };
  const ctx = { sessionKey: "agent:main:discord:channel:1482035270651220051" };

  const payload = buildAddMessagePayload(cfg, [{ role: "user", content: "hi" }], ctx);
  assert.equal(payload.user_id, "openclaw-user");
});
