# SmartComment for MemOS

English | [简体中文](README_zh.md)

SmartComment is an optional tracing plugin for MemOS that records memory creation, background processing, and retrieval as execution graphs. If a fact wasn't remembered or you need to trace the source of a search result, use the graphs to inspect message extraction, memory writes, and retrieval. They also help you reproduce failed cases, evaluate memory quality, and check changes to extraction or retrieval strategies.

The graph format and visualization tools come from [smartcomment](https://pypi.org/project/smartcomment/). You can also analyze the graphs with [MemTrace](https://github.com/zjunlp/MemTrace), a separate project whose AI agent inspects them to investigate memory-system failures.

The plugin is disabled by default, even after installation. Enable it as needed in your development or test environment. Normal MemOS usage does not require it.

## What you can see

| Capability | What you can inspect |
| --- | --- |
| Memory creation | The source messages, extracted content, and memory IDs returned by write operations. |
| Background processing | How MemRead enhanced memories, wrote the results, or deleted older memories. |
| Search stages | Whether a memory was retrieved or removed during filtering or deduplication, and the final result order and scores. |
| Search-to-Add history | The original messages and memory creation process behind final search results. Enable it with `MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD`. |
| Request browsing | Each user's `index.md` lists timestamps, request summaries, trace IDs, and links to the corresponding graphs. |

The recorded memory flows are:

```text
Add:    messages → extracted memories → written memories → background enhancement
Search: query → memory type → memory cube → retrieval → filtering → deduplication → reranking
```

## Quick start

### 1. Prepare your MemOS environment

Use Python 3.12 or newer. Follow the [MemOS deployment instructions](../../README.md) to configure the service, models, and storage, then activate the same Python environment that runs MemOS. Run these commands from the MemOS repository root:

```bash
# Skip this line if this MemOS checkout is already installed in the active environment.
python -m pip install -e .

python -m pip install "smartcomment>=0.1.2"
python -m pip install -e apps/memtrace-memos-integration
```

### 2. Enable the plugin and start the service

Set the environment variables before starting MemOS:

```bash
export MEMOS_ENABLED_PLUGINS=smartcomment
export MEMOS_SMARTCOMMENT_OUTPUT_DIR="$PWD/.memos/memtrace"

# Optional: include the origins of final search results. Disabled by default.
export MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD=true

python -m uvicorn memos.api.server_api:app --host 127.0.0.1 --port 8000 --workers 1
```

The startup log should contain `smartcomment plugin loaded`. If you use other opt-in plugins, keep their names in `MEMOS_ENABLED_PLUGINS`, separated by commas. Restart the service after changing plugin settings.

This command starts one worker. Each writer process needs its own output directory, so use separate directories if you run multiple workers.

### 3. Add a memory and search for it

Call `/product/add` and `/product/search` through the [local API documentation](http://127.0.0.1:8000/docs) or your existing client. To try the commands below, open another terminal and replace `YOUR_USER_ID` and `YOUR_CUBE_ID` with an existing user and memory cube. The [MemOS README](../../README.md) explains how to create a cube if you need one.

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

Wait for the Add request to succeed before searching. The plugin writes graph files asynchronously, so history linking also requires waiting for the Add graph to appear. Background enhancement may still be running.

Supply an `x-trace-id` request header to match a graph with your application logs. Requests with the same user and trace ID share a graph, so use a unique trace ID for each request if you want separate graphs. History linking works across different Add and Search trace IDs.

### 4. Find the recorded requests

With the output directory above, run this from the repository root:

```bash
find .memos/memtrace -type f -name index.md
```

Open your user's `index.md`. It lists requests newest first, with the request time and UTC offset, type, query or message summary, full trace ID, and a link to `graph.json`.

Example directory layout:

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

The first recorded event determines the request directory, which can also be `memread` or `other`. Later events append to the same graph and keep its original directory, even after a service restart.

### 5. Finish debugging

Remove `smartcomment` from `MEMOS_ENABLED_PLUGINS`, then restart MemOS. If it is your only enabled plugin and you set the variable in the shell, run:

```bash
unset MEMOS_ENABLED_PLUGINS
```

Remove `smartcomment` from any `.env` file or service configuration that also sets the variable. This leaves previously generated files in place.

## Visualize a graph

To use the `smartcomment` visualization tools, install the optional dependencies in your active environment:

```bash
python -m pip install "smartcomment[viz]>=0.1.2"
```

Run the following Python code, replacing `/path/to/graph.json` with a graph path from `index.md`:

```python
import json
from pathlib import Path

from smartcomment.runtime import ExecNetwork

data = json.loads(Path("/path/to/graph.json").read_text(encoding="utf-8"))
graph = ExecNetwork.import_graph(data)
graph.visualize(backend="pyvis", filename="trace.html", directed=True)
```

Open `trace.html` in a browser to explore the graph. To export a PNG, also install the Graphviz system application and replace the last line with:

```python
graph.visualize(backend="graphviz", filename="trace", format="png")
```

To export DOT without the optional visualization dependencies, replace the last line with:

```python
Path("trace.dot").write_text(graph.visualize(backend="dot"), encoding="utf-8")
```

## Trace search results back to their sources

Set `MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD=true` to include the recorded origins of final results in the Search graph:

```text
messages → extraction → write → enhancement → write ← final search results
```

Each history link shows the result's position (`rank`, starting at 1 within its final list) and observed score. Follow it to inspect the recorded path from the source messages to the search result in the same graph.

The corresponding Add history must already be saved in the same output directory and belong to the same user and project. The plugin matches memories by cube ID and memory ID, then copies the matched memories and their upstream history into the Search graph. The original Add files stay unchanged.

History linking covers final search results only. If a memory is missing from those results, inspect the original Add graph and compare the Search stage lists. The plugin skips missing or ambiguous history. Late Add events do not update an earlier Search graph; run another search after the history has been saved.

## Use with MemTrace

You can record and view graphs without installing MemTrace. To investigate them with an AI agent, install and configure MemTrace separately, then load `graph.json` in its graph exploration tools. Use a Search graph with history linking enabled to follow final results back to their source messages.

For MemTrace's batch error attribution and diagnostic reports, prepare the questions, model answers, reference answers, and annotations in the format those tools require, alongside the graphs. The plugin records server-side memory operations but does not capture answers generated by your client or evaluation script, so those data need to come from your evaluation workflow.

## Configuration

Set these environment variables before startup. Changes take effect after restarting MemOS; unset variables use the listed defaults.

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

Cache limits leave saved files on disk. Clean up output when you no longer need it, keeping the Add files needed for history linking. As history grows, each lookup scans more data.
