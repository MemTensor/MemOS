import { describe, expect, it } from "vitest";

import type { LogRecord } from "../../../agent-contract/log-record.js";
import { formatCompact } from "../../../core/logger/format/compact.js";
import { formatPretty } from "../../../core/logger/format/pretty.js";

const base: LogRecord = {
  ts: Date.UTC(2026, 5, 21, 21, 30, 45, 123),
  level: "info",
  kind: "app",
  channel: "core.session",
  msg: "session.opened",
};

describe("logger/format", () => {
  it("pretty formatter displays configured local time", () => {
    const out = formatPretty({ ...base, tz: "America/Los_Angeles" }, { color: false });
    expect(out.startsWith("14:30:45.123 INFO  [core.session] session.opened")).toBe(true);
  });

  it("compact formatter preserves UTC default output", () => {
    const out = formatCompact(base);
    expect(out.startsWith("2026-06-21T21:30:45.123Z info app ")).toBe(true);
  });

  it("compact formatter emits offset-bearing local timestamp", () => {
    const out = formatCompact({ ...base, tz: "America/Los_Angeles" });
    expect(out.startsWith("2026-06-21T14:30:45.123-07:00 info app ")).toBe(true);
  });
});
