# SmartComment for MemOS

English | [简体中文](README_zh.md)

SmartComment helps you understand **how MemOS turns messages into memories and retrieves them later**. This optional integration records memory operations as execution graphs, so you can investigate questions such as “Why wasn't this fact remembered?” or “Where did this search result come from?”

Use it when debugging a failed case, evaluating memory quality, or checking changes to extraction and retrieval strategies. The plugin is **disabled by default**, including after installation. Enable it when needed in your development or test environment; normal MemOS usage does not require it.

## What you can see

| Capability | Questions it helps answer |
| --- | --- |
| Memory creation | Which messages produced a memory? What was extracted, and which memory IDs were returned by the write operation? |
| Background processing | How did MemRead enhance memories, write the enhanced results, or delete older memories? |
| Search stages | Was a memory retrieved? Did it disappear during filtering or deduplication? What were the final order and scores? |
| Search-to-Add history | Which original messages and processing steps led to a final search result? This feature is optional. |
| Request browsing | Which graph belongs to a request? Each user gets an `index.md` with timestamps, request summaries, trace IDs, and graph links. |

The graphs follow these flows:

```text
Add:    messages → extracted memories → written memories → background enhancement
Search: query → memory type → memory cube → retrieval → filtering → deduplication → reranking
```

A memory cube is a MemOS memory collection. Search graphs show the result lists at the stages that actually ran; disabled filtering or deduplication stages are skipped. Background MemRead events can arrive after the API response and extend the original graph when they carry the same trace context.

The integration observes operations without changing their business results. Recording still consumes resources, and a graph reflects the operations observed by the plugin, rather than an independent check of the database.

## Quick start

### 1. Prepare your MemOS environment

Use **Python 3.12 or newer** and the **same Python environment that runs MemOS**. First follow the [MemOS deployment instructions](../../README.md) to configure the service, models, and storage. The commands below assume you are in the MemOS repository root.

```bash
# Skip this line if this MemOS checkout is already installed in the active environment.
python -m pip install -e .

python -m pip install "smartcomment>=0.1.2"
python -m pip install -e apps/memtrace-memos-integration
```

`smartcomment` is a public PyPI package; no separate source checkout is needed. The integration in this directory must also be installed.

If your environment uses `uv` and has no `pip` module, use `uv pip install --python .venv/bin/python` in place of `python -m pip install`, adjusting the interpreter path to your environment.

### 2. Enable the plugin and start the service

Set these variables **before starting MemOS**:

```bash
export MEMOS_ENABLED_PLUGINS=smartcomment
export MEMOS_SMARTCOMMENT_OUTPUT_DIR="$PWD/.memos/memtrace"

# Optional: include the origins of final search results. Disabled by default.
export MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD=true

python -m uvicorn memos.api.server_api:app --host 127.0.0.1 --port 8000 --workers 1
```

Look for `smartcomment plugin loaded` in the startup log. If you use other opt-in plugins, keep their names in `MEMOS_ENABLED_PLUGINS`, separated by commas. Restart the service whenever you change plugin settings.

The example uses one worker. Each writer process needs its own output directory; multiple workers must not write to the same directory.

### 3. Add a memory and search for it

Use the [local API documentation](http://127.0.0.1:8000/docs) or your existing client to call `/product/add` and `/product/search`. With an existing user and memory cube, you can try the following commands in another terminal. Replace `YOUR_USER_ID` and `YOUR_CUBE_ID` with your own values; see the [MemOS README](../../README.md) if you need to create a cube first.

```bash
curl -X POST http://127.0.0.1:8000/product/add \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "YOUR_USER_ID",
    "writable_cube_ids": ["YOUR_CUBE_ID"],
    "messages": [{"role": "user", "content": "I go swimming on Tuesdays and Thursdays."}],
    "async_mode": "sync"
  }'

curl -X POST http://127.0.0.1:8000/product/search \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "YOUR_USER_ID",
    "readable_cube_ids": ["YOUR_CUBE_ID"],
    "query": "When do I go swimming?"
  }'
```

Check that the Add request succeeds before searching. Graph files are written asynchronously; for Search-to-Add history, wait for the Add graph to appear before running Search. Background enhancement may continue afterward.

To match a graph with your application logs, you can supply an `x-trace-id` request header. Use a unique trace ID for each request if you want separate graphs: requests with the same user and trace ID share a graph. Add and Search do not need the same trace ID for history linking.

### 4. Find the recorded requests

With the output directory above, run this from the repository root:

```bash
find .memos/memtrace -type f -name index.md
```

Open your user's `index.md`. It lists requests newest first, with the request time and UTC offset, type, query or message summary, full trace ID, and a link to `graph.json`.

The main files are organized as follows; names below are illustrative and supporting index files are omitted:

```text
.memos/memtrace/
└── user--<hash>/
    ├── index.md
    └── 2026-11-17/
        ├── add/
        │   └── <time>__<trace>/
        │       ├── graph.json
        │       └── meta.json
        └── search/
            └── <time>__<trace>/
                ├── graph.json
                └── meta.json
```

- `graph.json` contains the execution graph; use it for visualization or analysis.
- `meta.json` contains request information, such as IDs, timestamps, and a summary.
- Dates and times use the service machine's local timezone by default. Set `MEMOS_SMARTCOMMENT_OUTPUT_TIMEZONE=Asia/Shanghai` or another IANA timezone to override it.

Some requests appear under `memread` or `other`, depending on the first event recorded. Later events continue the original graph, including after a service restart, without moving its directory.

### 5. Finish debugging

Remove `smartcomment` from `MEMOS_ENABLED_PLUGINS` and restart MemOS. If it is your only enabled plugin and you set it in the shell:

```bash
unset MEMOS_ENABLED_PLUGINS
```

Also remove it from any `.env` file or service configuration that sets the variable. Previously generated files remain available.

## Visualize a graph

The public `smartcomment` package provides visualization tools. Install its optional visualization dependencies in your active environment:

```bash
python -m pip install "smartcomment[viz]>=0.1.2"
```

Replace `/path/to/graph.json` with a graph path from `index.md`:

```bash
smartcomment-visualize /path/to/graph.json --backend pyvis --output trace.html
```

Open `trace.html` in a browser to explore the graph. For a PNG image, install the Graphviz system application as well, then run:

```bash
smartcomment-visualize /path/to/graph.json --backend graphviz --output trace.png
```

You can also export DOT source without the optional visualization dependencies:

```bash
smartcomment-visualize /path/to/graph.json --backend dot --output trace.dot
```

Pass **`graph.json`**, rather than a metadata or index JSON file, to these commands.

## Trace search results back to their sources

With `MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD=true`, a Search graph also includes the recorded origins of its final results:

```text
messages → extraction → write → enhancement → write ← final search results
```

Each history link shows the result's position (`rank`, starting at 1 within its final list) and observed score. This lets you inspect a result's recorded path from the original messages to retrieval in one graph.

For this to work, the corresponding Add history must already be saved in the **same output directory**, with the same user and project. The plugin matches memories by cube ID and memory ID. It includes the matched memories and their upstream history, leaving the original Add files unchanged.

History linking covers **final search results only**. To investigate a memory that never appeared in the final results, inspect the original Add graph and compare the Search stage lists. Missing or ambiguous history is left unlinked. Late Add events do not retroactively update an earlier Search graph; run another search once the history has been saved.

## Use with MemTrace

The three components have different roles:

| Component | Role |
| --- | --- |
| This MemOS integration | Records memory operations and saves execution graphs. |
| [smartcomment](https://pypi.org/project/smartcomment/) | Provides the shared graph format and visualization tools. |
| [MemTrace](https://github.com/zjunlp/MemTrace) | A separate project for exploring graphs with an AI agent and analyzing memory-system failures. |

You can use this plugin and view its output without installing MemTrace. For agent-assisted investigation, install and configure MemTrace separately, then use its graph exploration tools with `graph.json`. A Search graph with history linking enabled is useful for tracing final results back to their source messages.

The plugin records MemOS-side memory operations. It does not capture answers generated by your client or evaluation script. MemTrace's batch attribution and diagnostic-report workflows therefore require additional question, model-answer, reference-answer, and annotation data, organized in the format those tools expect. A graph file alone is not a complete evaluation case.

## Configuration

Set environment variables before startup and restart MemOS after changing them. The defaults below apply when no override is supplied.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMOS_ENABLED_PLUGINS` | Unset | Include `smartcomment` to enable this plugin; separate multiple plugin names with commas. |
| `MEMOS_SMARTCOMMENT_OUTPUT_DIR` | `.memos/memtrace` | Output directory. Relative paths resolve from the service's working directory. |
| `MEMOS_SMARTCOMMENT_OUTPUT_TIMEZONE` | `local` | Timezone for request directories and timestamps; accepts IANA names such as `Asia/Shanghai` or `UTC`. |
| `MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD` | `false` | Include recorded Add history for final search results. |
| `MEMOS_SMARTCOMMENT_MAX_VALUE_CHARS` | `20000` | Maximum captured length of each string. |
| `MEMOS_SMARTCOMMENT_PROJECT_ID` | `memos` | Project identifier saved in graphs and used for history matching. |
| `MEMOS_SMARTCOMMENT_QUEUE_SIZE` | `1024` | Maximum pending trace events; a full queue drops events and logs a warning. |
| `MEMOS_SMARTCOMMENT_MAX_CACHED_TRACES` | `64` | Maximum graphs cached in memory. |
| `MEMOS_SMARTCOMMENT_MAX_CACHED_GRAPH_ITEMS` | `50000` | Maximum total graph items cached in memory. |
| `MEMOS_SMARTCOMMENT_CACHE_TTL_SECONDS` | `300` | Idle cache expiration in seconds. |
| `MEMOS_SMARTCOMMENT_STRICT` | `false` | Enable stricter graph identity checks; usually leave this at its default. |

Cache limits do not remove saved files. Keep or clean up output according to your debugging needs; history linking needs the relevant Add files and scans more data as captured history grows.

## Troubleshooting and data handling

| Problem | What to check |
| --- | --- |
| No graph appears | Confirm both packages are installed in the service's Python environment, the plugin was enabled before startup, and the log contains `smartcomment plugin loaded`. Run an Add or Search request, allow time for background writes, and check the configured output path and writer warnings. |
| Search has no Add history | Enable history linking and restart. Confirm the Add graph was saved before Search, and the output directory, user, project, cube ID, and memory ID match. Memories absent from final results are not linked. |
| A graph seems incomplete | Background events may still be pending. Queue overflow, write failures, or abrupt process exit can also leave gaps; check the service logs. |
| Graph times differ from your browser's time | The default timezone is the service machine's, including inside containers. Set an explicit output timezone if needed. |

Credential-named fields are redacted, vector contents are omitted, and long strings are truncated. **Message text, memory text, and request summaries can still contain sensitive information.** Restrict access to the output directory and review graphs before sharing them.

If upgrading from the older flat `<user>/<trace>.json` layout, use a new output directory. Old files are not migrated or used for history linking.
