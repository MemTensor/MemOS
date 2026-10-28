import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "retry.sh");

test("captures one bounded log per retry attempt", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-plugin-retry-"));
  const attemptDirectory = join(directory, "attempts");
  const counter = join(directory, "counter");
  try {
    execFileSync(
      "bash",
      [
        script,
        "--attempts",
        "3",
        "--delay",
        "0",
        "--max-delay",
        "0",
        "--label",
        "captured retry",
        "--",
        "bash",
        "-c",
        'count=0; [ ! -f "$1" ] || count="$(tr -d \'[:space:]\' <"$1")"; count=$((count + 1)); printf \'%s\\n\' "$count" >"$1"; printf \'attempt %s\\n\' "$count"; [ "$count" -ge 3 ]',
        "retry-attempt",
        counter,
      ],
      {
        env: { ...process.env, RETRY_ATTEMPT_DIR: attemptDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(readFileSync(counter, "utf8").trim(), "3");
    assert.equal(readFileSync(join(attemptDirectory, "1.log"), "utf8").trim(), "attempt 1");
    assert.equal(readFileSync(join(attemptDirectory, "2.log"), "utf8").trim(), "attempt 2");
    assert.equal(readFileSync(join(attemptDirectory, "3.log"), "utf8").trim(), "attempt 3");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves the final command exit code while retaining exhausted-attempt logs", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-plugin-retry-failure-"));
  try {
    const result = spawnSync(
      "bash",
      [
        script,
        "--attempts",
        "3",
        "--delay",
        "0",
        "--max-delay",
        "0",
        "--label",
        "failed retry",
        "--",
        "bash",
        "-c",
        'printf "retry failed\\n"; exit 7',
      ],
      {
        env: { ...process.env, RETRY_ATTEMPT_DIR: directory },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 7);
    for (const attempt of [1, 2, 3]) {
      assert.equal(readFileSync(join(directory, `${attempt}.log`), "utf8").trim(), "retry failed");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
