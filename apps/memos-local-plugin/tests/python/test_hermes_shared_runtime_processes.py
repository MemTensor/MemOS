"""Five-process smoke test for the Hermes shared MemoryCore owner."""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import subprocess
import tempfile
import time
import unittest

from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
PROXY = PLUGIN_ROOT / "dist" / "adapters" / "openclaw" / "runtime-stdio-proxy.js"


class HermesSharedRuntimeProcessTests(unittest.TestCase):
    def test_five_processes_share_one_owner_and_keep_sessions_isolated(self) -> None:
        self.assertTrue(PROXY.exists(), "run `npm run build` before this test")
        with tempfile.TemporaryDirectory(prefix="memos-hermes-runtime-") as temp:
            home = Path(temp)
            (home / "config.yaml").write_text(
                """version: 1
llm:
  fallbackToHost: false
algorithm:
  capture:
    embedTraces: false
    alphaScoring: false
    synthReflections: false
  reward:
    llmScoring: false
  l2Induction:
    useLlm: false
  l3Abstraction:
    useLlm: false
  skill:
    useLlm: false
  feedback:
    useLlm: false
  retrieval:
    llmFilterEnabled: false
""",
                encoding="utf-8",
            )
            env = {
                **os.environ,
                "MEMOS_HOME": str(home),
                "MEMOS_HERMES_RUNTIME_MODE": "shared",
                "MEMOS_RUNTIME_DRAIN_TIMEOUT_MS": "30000",
            }
            clients: list[subprocess.Popen[str]] = []
            try:
                for _ in range(5):
                    clients.append(
                        subprocess.Popen(
                            ["node", str(PROXY), "--agent=hermes", f"--home={home}"],
                            stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            text=True,
                            encoding="utf-8",
                            bufsize=1,
                            env=env,
                            cwd=PLUGIN_ROOT,
                        )
                    )

                expected = {f"hermes:parallel:{index}" for index in range(5)}
                for index, client in enumerate(clients):
                    assert client.stdin is not None
                    client.stdin.write(
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": 1,
                                "method": "session.open",
                                "params": {
                                    "agent": "hermes",
                                    "sessionId": f"hermes:parallel:{index}",
                                    "namespace": {
                                        "agentKind": "hermes",
                                        "profileId": "eval",
                                    },
                                },
                            }
                        )
                        + "\n"
                    )
                    client.stdin.flush()

                returned: set[str] = set()
                for client in clients:
                    assert client.stdout is not None
                    response = json.loads(client.stdout.readline())
                    self.assertNotIn("error", response)
                    returned.add(response["result"]["sessionId"])
                self.assertSetEqual(returned, expected)

                for index, client in enumerate(clients):
                    assert client.stdin is not None
                    client.stdin.write(
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": 2,
                                "method": "turn.start",
                                "params": {
                                    "agent": "hermes",
                                    "sessionId": f"hermes:parallel:{index}",
                                    "userText": f"parallel-capture-marker-{index}",
                                    "ts": 1_700_000_000_000 + index,
                                    "contextHints": {"trialKey": f"parallel/{index}"},
                                },
                            }
                        )
                        + "\n"
                    )
                    client.stdin.flush()

                episode_ids: list[str] = []
                for client in clients:
                    assert client.stdout is not None
                    response = json.loads(client.stdout.readline())
                    self.assertNotIn("error", response)
                    result = response["result"]
                    episode_ids.append(result.get("episodeId") or result["query"]["episodeId"])

                for index, (client, episode_id) in enumerate(
                    zip(clients, episode_ids, strict=False)
                ):
                    assert client.stdin is not None
                    client.stdin.write(
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": 3,
                                "method": "turn.end",
                                "params": {
                                    "agent": "hermes",
                                    "sessionId": f"hermes:parallel:{index}",
                                    "episodeId": episode_id,
                                    "requestId": f"hermes-turn-parallel-{index}",
                                    "agentText": f"parallel-result-marker-{index}",
                                    "toolCalls": [],
                                    "ts": 1_700_000_001_000 + index,
                                    "contextHints": {"trialKey": f"parallel/{index}"},
                                },
                            }
                        )
                        + "\n"
                    )
                    client.stdin.write(
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": 4,
                                "method": "turn.end",
                                "params": {
                                    "agent": "hermes",
                                    "sessionId": f"hermes:parallel:{index}",
                                    "episodeId": episode_id,
                                    "requestId": f"hermes-turn-parallel-{index}",
                                    "agentText": f"parallel-result-marker-{index}",
                                    "toolCalls": [],
                                    "ts": 1_700_000_001_000 + index,
                                    "contextHints": {"trialKey": f"parallel/{index}"},
                                },
                            }
                        )
                        + "\n"
                    )
                    client.stdin.flush()

                for client in clients:
                    assert client.stdout is not None
                    responses = [
                        json.loads(client.stdout.readline()),
                        json.loads(client.stdout.readline()),
                    ]
                    for response in responses:
                        self.assertNotIn("error", response)
                        self.assertTrue(response["result"]["traceId"])
                    self.assertEqual(responses[0]["result"], responses[1]["result"])

                owner_path = home / "daemon" / "shared-runtime.lock" / "owner.json"
                deadline = time.monotonic() + 10
                while not owner_path.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                owner = json.loads(owner_path.read_text(encoding="utf-8"))
                self.assertEqual(owner["agent"], "hermes")
                self.assertGreater(owner["pid"], 0)

                for client in clients:
                    assert client.stdin is not None
                    client.stdin.close()
                for client in clients:
                    exit_code = client.wait(timeout=15)
                    assert client.stderr is not None
                    error_output = client.stderr.read()
                    self.assertEqual(exit_code, 0, error_output)

                shutdown_deadline = time.monotonic() + 30
                while owner_path.exists() and time.monotonic() < shutdown_deadline:
                    time.sleep(0.05)
                self.assertFalse(owner_path.exists(), "shared runtime did not drain and stop")

                db_file = home / "data" / "memos.db"
                with sqlite3.connect(db_file) as db:
                    actual = {
                        row[0]
                        for row in db.execute(
                            "SELECT id FROM sessions WHERE id LIKE 'hermes:parallel:%'"
                        )
                    }
                    trace_rows = db.execute(
                        "SELECT session_id, user_text, agent_text FROM traces "
                        "WHERE session_id LIKE 'hermes:parallel:%'"
                    ).fetchall()
                    integrity = db.execute("PRAGMA quick_check").fetchone()[0]
                self.assertSetEqual(actual, expected)
                self.assertEqual(len(trace_rows), 5)
                for index in range(5):
                    self.assertIn(
                        (
                            f"hermes:parallel:{index}",
                            f"parallel-capture-marker-{index}",
                            f"parallel-result-marker-{index}",
                        ),
                        trace_rows,
                    )
                self.assertEqual(integrity, "ok")
            finally:
                for client in clients:
                    if client.poll() is None:
                        client.terminate()
                for client in clients:
                    try:
                        client.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        client.kill()
                        client.wait(timeout=5)
                    for stream in (client.stdin, client.stdout, client.stderr):
                        if stream is not None:
                            with contextlib.suppress(Exception):
                                stream.close()


if __name__ == "__main__":
    unittest.main()
