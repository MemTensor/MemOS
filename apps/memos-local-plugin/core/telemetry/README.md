# `core/telemetry/`

> Anonymous usage telemetry. **Opt-out by default-on**, `telemetry.enabled`
> in `config.yaml` flips it off.

## What we send

- Plugin version + agent kind (`openclaw` / `hermes`).
- Aggregate counts per 24 h window: episodes, skills crystallised,
  retrievals served, feedback submitted.
- Provider choices (`llm.provider`, `embedding.provider`) — for
  integration debugging; never the API keys.
- Wall-clock latency percentiles for hot paths.

## What we never send

- Raw user text or agent output.
- File paths, workspace names, hostnames.
- Any content of L1/L2/L3/Skill/Feedback rows.
- Anything from `audit.log` or `llm.jsonl`.

## Payload shape

```
{
  "pluginVersion": "2.0.0-beta.1",
  "agent": "openclaw",
  "window": { "start": 1712345678000, "end": 1712432078000 },
  "counts": { "episodes": 12, "skillsCrystallised": 1, "retrievals": 34, "feedbacks": 3 },
  "providers": { "llm": "openai_compatible", "embedding": "local" },
  "p50Ms": { "turnStart": 180, "turnEnd": 42 },
  "schemaVersion": 1
}
```

## Privacy guarantees

- **No crashes are reported**: telemetry is append-only stats; error
  bodies go to `audit.log` locally and nowhere else.
- The send function is gated on `telemetry.enabled === true`. A failed
  send is swallowed and retried at the next flush — it never blocks a
  turn.
- Users can inspect every payload before sending via
  `GET /api/v1/telemetry/preview` on the local server.

## Tests

- `tests/unit/telemetry/` — payload redaction + opt-out enforcement.
