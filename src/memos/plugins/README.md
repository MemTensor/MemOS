# MemOS Plugin System

This directory contains the Python plugin framework for MemOS. It is used by
the API service and scheduler runtime to load in-process extensions.

The framework currently supports:

- Python package discovery through the `memos.plugins` entry-point group.
- Plugin lifecycle hooks: `on_load`, `init_components`, `init_app`,
  `on_shutdown`.
- FastAPI router and middleware registration.
- Hook callbacks for add/search/mem-reader/memory-version/Dream extension
  points.
- Runtime component injection, such as graph DB, embedder, LLM, and configs.
- Enable/disable controls through environment variables.
- Priority-based selection when multiple packages provide the same logical
  plugin.

It is not a remote sandbox, marketplace, or hot-reload system. Plugins run in
the same Python process as MemOS, so callbacks should be fast, defensive, and
careful with side effects.

## Files

| File | Purpose |
| ---- | ------- |
| `base.py` | `MemOSPlugin` base class and registration helpers. |
| `manager.py` | Entry-point discovery, enable/disable logic, lifecycle orchestration. |
| `hook_defs.py` | Core hook names and hook specs. |
| `hooks.py` | Hook registry, trigger helpers, and `@hookable`. |
| `component_bootstrap.py` | Builds the context passed to `init_components`. |

Useful references:

- Built-in plugin example: `src/memos/dream/plugin.py`
- API startup: `src/memos/api/server_api.py`
- Component bootstrap: `src/memos/api/handlers/component_init.py`
- Tests: `tests/plugins/`

## Lifecycle

Plugins are discovered from installed Python entry points:

```toml
[project.entry-points."memos.plugins"]
my_plugin = "my_plugin.plugin:MyPlugin"
```

During startup, `PluginManager`:

1. Loads each entry point and instantiates the plugin class.
2. Keeps only instances that inherit from `MemOSPlugin`.
3. Resolves duplicate logical names by `priority`.
4. Applies enable/disable environment variables.
5. Calls `on_load()`.
6. Calls `init_components(context)` when runtime components are ready.
7. Calls `init_app()` after binding the FastAPI app.

`on_shutdown()` is called when plugins are shut down.

Environment variables:

- `MEMOS_DISABLED_PLUGINS`: comma-separated plugin names to disable.
- `MEMOS_ENABLED_PLUGINS`: comma-separated plugin names to enable when
  `enabled_by_default = False`.

Disable wins if a plugin appears in both lists.

## Minimal Plugin

```python
from fastapi import APIRouter

from memos.plugins import H, MemOSPlugin


class MyPlugin(MemOSPlugin):
    name = "my_plugin"
    version = "0.1.0"
    description = "Example MemOS plugin"
    priority = 0
    enabled_by_default = True

    def on_load(self) -> None:
        self.register_hook(H.SEARCH_AFTER, self.on_search_after)

    def init_components(self, context: dict) -> None:
        self.context = context

    def init_app(self) -> None:
        router = APIRouter(prefix="/my-plugin", tags=["my-plugin"])

        @router.get("/health")
        def health() -> dict[str, object]:
            return {"plugin": self.name, "version": self.version}

        self.register_router(router)

    def on_search_after(self, *, request, result, **kwargs):
        return result

    def on_shutdown(self) -> None:
        self.context = {}
```

Install the package into the same Python environment as MemOS:

```bash
pip install -e /path/to/my_plugin
```

Then restart the MemOS service.

## Hooks

Core hook names are exposed through `memos.plugins.H`.

Common hooks include:

| Hook | Purpose |
| ---- | ------- |
| `add.before` / `add.after` | Modify add requests or results. |
| `search.before` / `search.after` | Modify search requests or results. |
| `search.memory_results` | Add result buckets before thresholding, dedup, and reranking. |
| `mem_reader.pre_extract` | Customize memory-reader extraction prompts. |
| `memory_items.after_fine_extract` | Post-process extracted memory items. |
| `memory_version.prepare_updates` | Prepare versioned-memory candidates. |
| `memory_version.apply_updates` | Apply versioned-memory updates. |
| `memory_version.apply_feedback_update` | Apply version semantics during feedback updates. |
| `dream.execute` | Execute the active Dream pipeline. |

Hooks may define a `pipe_key`. If a callback returns a non-`None` value, that
value replaces the piped argument for the next callback. Returning `None` means
"leave the current value unchanged".

Plugin-owned hooks should be declared inside the plugin package with
`define_hook`, not added to core `hook_defs.py`.

## Runtime Context

`init_components(context)` receives a mutable context with:

- `context["shared"]`: runtime objects such as `graph_db`, `embedder`, `llm`,
  `mem_scheduler`, and scheduler submit handles.
- `context["configs"]`: default cube, NLI, mem-reader, reranker, feedback
  reranker, and internet retriever configs.

Keep the context reference if your plugin needs values that may be attached
later during bootstrap.

## Development Notes

- Namespace plugin routes, for example `/my-plugin/...`.
- Keep hook callbacks narrow and resilient; do not let optional features break
  core add/search paths.
- Guard optional third-party imports with clear installation messages.
- Use `memos.log.get_logger(__name__)`; do not print secrets, vectors, or raw
  user data.
- Make `on_shutdown()` idempotent.
- Add tests for hook registration, piped returns, component context handling,
  router registration, and enable/disable behavior.

For core framework changes, run:

```bash
poetry run pytest tests/plugins/ -q
```

## Related Plugin-Like Projects

The TypeScript/OpenClaw/Hermes projects under `apps/` are separate host
integrations. They are not loaded by this Python `PluginManager` unless they
also publish a Python entry point under `memos.plugins`.
