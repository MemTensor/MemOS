import test from "node:test";
import assert from "node:assert/strict";

import plugin from "../index.js";
import { addMessage, buildConfig } from "../lib/memos-cloud-api.js";

const createAgentEndHandler = (sessionKey, sessionId, pluginConfig = {}) => {
  const hooks = new Map();
  const logs = [];
  plugin.register({
    config: { hooks: { internal: { enabled: false } } },
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
    pluginConfig: {
      apiKey: "mpg-test",
      baseUrl: "http://memos.test",
      recallEnabled: false,
      rumEnabled: false,
      ...pluginConfig,
    },
    on: (name, handler) => hooks.set(name, handler),
    registerHook: () => {},
  });

  return {
    handler: hooks.get("agent_end"),
    ctx: { sessionKey, sessionId },
    logs,
  };
};

const turn = (messages) => ({ success: true, messages });

test("uses a 5 second MemOS API timeout by default", () => {
  assert.equal(buildConfig({}).timeoutMs, 5_000);
});

test("add/message uses the configured retry count", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new Error("network down");
  };

  try {
    await assert.rejects(
      addMessage(
        {
          apiKey: "mpg-test",
          baseUrl: "http://memos.test",
          timeoutMs: 10,
          retries: 1,
        },
        { messages: [{ role: "user", content: "hello" }] },
      ),
    );
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("add/message can disable retries through configuration", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new Error("network down");
  };

  try {
    await assert.rejects(
      addMessage(
        {
          apiKey: "mpg-test",
          baseUrl: "http://memos.test",
          timeoutMs: 10,
          retries: 0,
        },
        { messages: [{ role: "user", content: "hello" }] },
      ),
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("replayed agent_end writes the same logical turn only once", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async (_url, options) => {
    if (_url.endsWith("/add/message")) adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx, logs } = createAgentEndHandler("agent:main:test:dedup-replay");
    const event = {
      ...turn([
        { role: "user", content: "remember replay test" },
        { role: "assistant", content: [{ type: "text", text: "noted" }] },
      ]),
      runId: "run-dedup-replay",
    };

    await handler(event, ctx);
    await handler(event, ctx);

    assert.equal(adds, 1);
    assert.ok(logs.some((line) => line.includes("duplicate agent_end snapshot")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("40 redeliveries do not exceed the configured two add attempts", async () => {
  const originalFetch = globalThis.fetch;
  let acceptedWrites = 0;
  globalThis.fetch = async (_url, options) => {
    acceptedWrites += 1;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler(
      "agent:main:test:slow-redelivery",
      "session-slow-redelivery",
      { timeoutMs: 10 },
    );
    const messages = [
      { role: "user", content: "remember slow redelivery", timestamp: 1_784_800_000_000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "noted" }],
        timestamp: 1_784_800_000_100,
      },
    ];

    for (let replay = 0; replay < 40; replay += 1) {
      await handler({ ...turn(messages), runId: `run-redelivery-${replay}` }, ctx);
    }

    assert.equal(acceptedWrites, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("replayed agent_end without a run id uses stable message ids", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler("agent:main:test:dedup-message-id");
    const event = turn([
      { role: "user", content: "remember replay test", id: "message-user-1" },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
    ]);

    await handler(event, ctx);
    await handler(event, ctx);

    assert.equal(adds, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a changed message list is not deduplicated even when the run id is unchanged", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler("agent:main:test:changed-snapshot");
    const userMessage = {
      role: "user",
      content: "same request",
      idempotencyKey: "request-123",
    };

    await handler({
      ...turn([
        userMessage,
        { role: "assistant", content: [{ type: "text", text: "first attempt" }] },
      ]),
      runId: "run-changed-snapshot",
    }, ctx);
    await handler({
      ...turn([
        userMessage,
        { role: "assistant", content: [{ type: "text", text: "fallback attempt" }] },
      ]),
      runId: "run-changed-snapshot",
    }, ctx);

    assert.equal(adds, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a timed-out add is not resent beyond configured retries when the turn is replayed", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    throw new DOMException("aborted", "AbortError");
  };

  try {
    const { handler, ctx, logs } = createAgentEndHandler("agent:main:test:dedup-timeout");
    const event = {
      ...turn([
        { role: "user", content: "remember timeout test" },
        { role: "assistant", content: [{ type: "text", text: "noted" }] },
      ]),
      runId: "run-dedup-timeout",
    };

    await handler(event, ctx);
    await handler(event, ctx);

    assert.equal(adds, 2);
    assert.ok(logs.some((line) => line.includes("add failed")));
    assert.ok(logs.some((line) => line.includes("duplicate agent_end snapshot")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hook redelivery does not reset an exhausted retry budget", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new Error("connection refused");
  };

  try {
    const { handler, ctx } = createAgentEndHandler(
      "agent:main:test:definite-failure-redelivery",
      "session-definite-failure-redelivery",
      { retries: 0 },
    );
    const messages = [
      { role: "user", content: "retry a definite failure", timestamp: 1_784_800_000_200 },
      {
        role: "assistant",
        content: [{ type: "text", text: "noted" }],
        timestamp: 1_784_800_000_300,
      },
    ];

    for (let replay = 0; replay < 5; replay += 1) {
      await handler({ ...turn(messages), runId: `run-definite-failure-${replay}` }, ctx);
    }

    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the same text in a later turn is still written", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler("agent:main:test:dedup-new-turn");
    const first = [
      { role: "user", content: "same text" },
      { role: "assistant", content: [{ type: "text", text: "same reply" }] },
    ];
    const second = [
      ...first,
      { role: "user", content: "same text" },
      { role: "assistant", content: [{ type: "text", text: "same reply" }] },
    ];

    await handler({ ...turn(first), runId: "run-first" }, ctx);
    await handler({ ...turn(second), runId: "run-second" }, ctx);

    assert.equal(adds, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("last-turn replay is deduplicated when older history changes", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler(
      "agent:main:test:changed-history-same-turn",
      "session-changed-history-same-turn",
    );
    const currentTurn = [
      {
        role: "user",
        content: "capture this turn",
        idempotencyKey: "message-current-user",
        timestamp: 1_784_800_010_000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "captured" }],
        timestamp: 1_784_800_010_100,
      },
    ];

    await handler({
      ...turn([
        { role: "user", content: "old history", timestamp: 1_784_800_009_000 },
        { role: "assistant", content: [{ type: "text", text: "old reply" }] },
        ...currentTurn,
      ]),
      runId: "run-history-first",
    }, ctx);
    await handler({
      ...turn([
        { role: "user", content: "rewritten history", timestamp: 1_784_800_009_500 },
        { role: "assistant", content: [{ type: "text", text: "rewritten reply" }] },
        ...currentTurn,
      ]),
      runId: "run-history-replay",
    }, ctx);

    assert.equal(adds, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("full-session capture treats changed history as a new snapshot", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler(
      "agent:main:test:full-session-history",
      "session-full-session-history",
      { captureStrategy: "full_session" },
    );
    const currentTurn = [
      {
        role: "user",
        content: "current turn",
        idempotencyKey: "full-session-current-user",
        timestamp: 1_784_800_020_000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "current reply" }],
        timestamp: 1_784_800_020_100,
      },
    ];

    await handler({
      ...turn([
        { role: "user", content: "first history", timestamp: 1_784_800_019_000 },
        { role: "assistant", content: [{ type: "text", text: "first history reply" }] },
        ...currentTurn,
      ]),
      runId: "run-full-session-first",
    }, ctx);
    await handler({
      ...turn([
        { role: "user", content: "changed history", timestamp: 1_784_800_019_500 },
        { role: "assistant", content: [{ type: "text", text: "changed history reply" }] },
        ...currentTurn,
      ]),
      runId: "run-full-session-second",
    }, ctx);

    assert.equal(adds, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an older snapshot replayed after the session advances is still deduplicated", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler("agent:main:test:out-of-order-replay");
    const first = [
      { role: "user", content: "first turn", timestamp: 1_784_800_000_400 },
      {
        role: "assistant",
        content: [{ type: "text", text: "first reply" }],
        timestamp: 1_784_800_000_500,
      },
    ];
    const second = [
      ...first,
      { role: "user", content: "second turn", timestamp: 1_784_800_000_600 },
      {
        role: "assistant",
        content: [{ type: "text", text: "second reply" }],
        timestamp: 1_784_800_000_700,
      },
    ];

    await handler({ ...turn(first), runId: "run-old-first" }, ctx);
    await handler({ ...turn(second), runId: "run-old-second" }, ctx);
    await handler({ ...turn(first), runId: "run-old-redelivery" }, ctx);

    assert.equal(adds, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the same current-turn content with new message timestamps is still written", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler("agent:main:test:same-content-new-message");
    const first = [
      { role: "user", content: "same text", timestamp: 1_784_800_001_000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "same reply" }],
        timestamp: 1_784_800_001_100,
      },
    ];
    const second = [
      { role: "user", content: "same text", timestamp: 1_784_800_002_000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "same reply" }],
        timestamp: 1_784_800_002_100,
      },
    ];

    await handler({ ...turn(first), runId: "run-same-content-first" }, ctx);
    await handler({ ...turn(second), runId: "run-same-content-second" }, ctx);

    assert.equal(adds, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the same event snapshot in a new conversation is still written", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const first = createAgentEndHandler("agent:main:test:new-conversation", "session-1");
    const second = createAgentEndHandler("agent:main:test:new-conversation", "session-2");
    const event = {
      ...turn([
        { role: "user", content: "same text" },
        { role: "assistant", content: [{ type: "text", text: "same reply" }] },
      ]),
      runId: "run-shared",
    };

    await first.handler(event, first.ctx);
    await second.handler(event, second.ctx);

    assert.equal(adds, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("events without a reliable run or message identity are not deduplicated", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler("agent:main:test:no-event-identity");
    const event = turn([
      { role: "user", content: "same text" },
      { role: "assistant", content: [{ type: "text", text: "same reply" }] },
    ]);

    await handler(event, ctx);
    await handler(event, ctx);

    assert.equal(adds, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a configured conversation id is not treated as a reliable OpenClaw session identity", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async () => {
    adds += 1;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { handler, ctx } = createAgentEndHandler(undefined, undefined, {
      conversationId: "shared-configured-conversation",
    });
    const event = turn([
      { role: "user", content: "same text", timestamp: 1_784_800_003_000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "same reply" }],
        timestamp: 1_784_800_003_100,
      },
    ]);

    await handler(event, ctx);
    await handler(event, ctx);

    assert.equal(adds, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
