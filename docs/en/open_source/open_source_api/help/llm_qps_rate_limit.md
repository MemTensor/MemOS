# LLM GCRA Rate Limiting

## Environment Variables

Rate limiting exposes only two environment variables and is disabled by default. Only explicitly selected models are limited.

```dotenv
MEMOS_LLM_RATE_LIMIT_ENABLED=false
MEMOS_LLM_RATE_LIMIT_RULES='{"gpt-4o-mini":{"qps":5,"burst":2,"max_wait_seconds":30,"queue_capacity":16,"retry_attempts":1}}'
```

`RULES` is a JSON object keyed by the actual model name used in requests. Each rule accepts only the following five parameters. Omitted parameters use the code defaults:

| Parameter | Default | Description |
|---|---:|---|
| qps | 5 | Global sustained admission rate, aggregated across all workers sharing the quota |
| burst | 2 | Total number of requests that can be admitted immediately after an idle period; not qps plus burst |
| max_wait_seconds | 30 | Cumulative permit-wait budget in seconds for a single primary/backup invocation and its managed retries |
| queue_capacity | 16 | Waiting queue capacity per process and model, including the head currently requesting a permit |
| retry_attempts | 1 | Maximum retries after the initial model request fails; 0 disables retries |

The example matches the code defaults and `docker/.env.example-full`, with rate limiting disabled. Set `MEMOS_LLM_RATE_LIMIT_ENABLED=true` explicitly to enable it. These values are a conservative starting point for open-source deployments, not provider-guaranteed quotas. Adjust them based on your actual quota, shared environments, worker count, queue waits, and rate-limit errors. QPS limiting is not a token-throughput or in-flight concurrency limit.

- When `RULES` is not set, only `gpt-4o-mini` is selected, using the defaults above.
- Explicit `RULES` replace the entire model rule set. Unlisted models are unaffected; the default model is not implicitly added.
- `RULES={}` limits no models. Remove a model entry to disable limiting for that model.
- `ENABLED=false` disables the entire feature.
- Model names do not support wildcards. qps must be finite and positive; burst and queue capacity must be positive integers; retry attempts must be a nonnegative integer.
- The outer single quotes in shell/`.env` examples protect the JSON. Omit them when entering the environment variable value directly in a deployment platform.

Example with separate rules for multiple models:

```dotenv
MEMOS_LLM_RATE_LIMIT_RULES='{"gpt-4o-mini":{"qps":5,"burst":2,"max_wait_seconds":30,"queue_capacity":16,"retry_attempts":1},"qwen-flash":{"qps":10,"burst":2,"max_wait_seconds":3,"queue_capacity":8,"retry_attempts":0}}'
```

The second model is illustrative and is not selected by default.

## Redis and Configuration Loading

The limiter reuses the existing `MEMSCHEDULER_REDIS_HOST/PORT/DB/USERNAME/PASSWORD/SSL` connection settings. A missing host causes a configuration error on the first limited invocation. No Redis client is created while the feature is disabled. Inject passwords through deployment secrets.

Redis keys are generated automatically per model; no scope configuration is needed:

```text
memos:llm:gcra:gpt-4o-mini
memos:llm:gcra:qwen-flash
```

Workers and environments using the same Redis instance, database, prefix, and model name share one theoretical arrival time (TAT). Different endpoints or API keys do not create separate quotas. Different models have independent TAT values and local queues; model aliases are treated as distinct models. All environments sharing a quota must use consistent qps and burst settings.

Configuration is loaded when the LLM configuration object is created, not on every request. The limiter does not load `.env` itself. Coordinate worker restarts after changing deployment settings. Explicit Python `rate_limit` configuration can still override environment values. Configuration objects retain internal runtime parameters for programmatic construction and testing, but those parameters have no environment-variable interface.

Remove all legacy `MEMOS_LLM_RATE_LIMIT_*` variables other than `ENABLED` and `RULES`, including MODELS, QPS, BURST, SCOPE, CONFIG_FILE, REDIS_*, and WAIT_JITTER_SECONDS. Unsupported variables cause a configuration-loading error rather than being silently ignored. Also remove enabled, scope, jitter, and backoff parameters from old model rules. Selecting a separate JSON configuration file through an environment variable is no longer supported.

When migrating from hashed keys or an older prefix, coordinate the switch across all instances to avoid simultaneous admission through both old and new keys. A new key starts with a full burst allowance. Do not change prefixes arbitrarily while the system is running.

## Internal Behavior

- Lua uses Redis TIME to atomically read, check, and update TAT. Rejection does not advance TAT. Python uses register_script; a local Lua installation is not required.
- Only the queue head requests a Redis permit for each process and model. Other threads wait on a Condition. Once admitted, a request leaves the queue immediately and starts the model call without waiting for earlier model calls to finish.
- A random jitter of 0 to 10 ms is added to Redis's suggested wait. Without a valid Retry-After, retries use exponential backoff with jitter, a 1-second base, and an 8-second cap. These are internal defaults and need no deployment configuration.
- Managed invocations disable hidden SDK retries. Connection/timeout errors and HTTP 408, 409, 429, and 5xx responses can be retried within the configured retry limit. Every retry must acquire a new permit. If Retry-After exceeds the internal wait limit, the request is not retried earlier than requested.
- Streaming requests are retried only during establishment. Errors after streaming starts do not replay the stream. Callers that stop consuming early should close the generator.
- A full queue, an expired wait budget, and Redis unavailability raise LLMRateLimitQueueFullError, LLMRateLimitTimeoutError, and LLMRateLimitUnavailableError respectively. These errors do not bypass the limiter through a backup model.
- Redis connection and read timeouts default to 0.5 seconds. The default failure policy is closed, which stops limited invocations. A late Redis response does not cause a model request to be sent, and permits already consumed or with uncertain status are not refunded.
- max_wait_seconds excludes model network time and failure backoff. It is not a total business-request timeout; callers still need an outer deadline. Synchronous Redis I/O may need to wait until the socket timeout before exiting.
- The local queue is not a durable task queue. Queue overflow, wait timeouts, and process exits do not automatically defer tasks. Redis failover or eviction of TAT keys may also reset the allowance.

## Scope and Verification

The integration currently covers Chat Completions in OpenAILLM and its Qwen, DeepSeek, and MiniMax subclasses, including regular calls, streaming establishment, and backup models. Independent implementations such as Azure, the Responses API, Ollama, and VLLM are not integrated yet.

This version controls QPS only, not token usage, token traffic growth, or in-flight concurrency. It cannot guarantee prevention of every provider-side 429 response.

INFO-level `[LLM_RATE_LIMIT] sending` logs record the model, attempt number, and permit-wait duration. WARNING logs record retries, queue overflow, wait timeouts, and Redis failures. The new logs do not include request bodies or credentials.

```sh
poetry run pytest tests/configs/ tests/llms/ -q
MEMOS_TEST_LOCAL_REDIS=1 poetry run pytest tests/llms/test_qps_rate_limit_redis.py -q
```

The second command starts an isolated local Redis instance using only a Unix socket, with no TCP listener or persistence. It does not read production Redis settings. Logs are stored in a pytest-managed `redis-gcra*` temporary directory; the short-path temporary socket is cleaned up on exit.
