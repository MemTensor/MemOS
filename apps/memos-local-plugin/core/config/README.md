# core/config/

Configuration loader, validator, and writer for the plugin.

## Where config lives

There is exactly **one** configuration file per agent install:

| Agent    | Path                                       |
|----------|--------------------------------------------|
| OpenClaw | `~/.openclaw/memos-plugin/config.yaml`     |
| Hermes   | `~/.hermes/memos-plugin/config.yaml`       |

Both are created by `install.sh` from `templates/config.<agent>.yaml`.

Override locations during testing or CI:

| Env var             | What it overrides                                         |
|---------------------|-----------------------------------------------------------|
| `MEMOS_HOME`        | The whole runtime home. `<MEMOS_HOME>/config.yaml` is read. |
| `MEMOS_CONFIG_FILE` | A specific YAML file path.                                |

`MEMOS_HOME` wins over `MEMOS_CONFIG_FILE` if both are set.

## Why YAML (and only YAML)

- Humans actually read it.
- Comments survive (the writer preserves them).
- Sensitive fields (API keys, tokens) live alongside everything else, so users
  edit one place. The file is `chmod 600`.

There is no `.env`. If you find yourself wanting one, fix the YAML schema
instead.

## Public API

```ts
import { loadConfig } from "./index.js";
import { resolveHome } from "./paths.js";

const home   = resolveHome("openclaw");      // {root, configFile, dataDir, …}
const config = await loadConfig(home);       // ResolvedConfig
```

`loadConfig`:

1. Reads `home.configFile` (if missing, returns `defaults` and emits a config
   warning — startup must still succeed so the agent isn't blocked).
2. Merges YAML over `defaults.ts`.
3. Validates with the typebox schema (`schema.ts`).
4. Returns a frozen `ResolvedConfig`.

Writing is symmetric:

```ts
import { patchConfig } from "./writer.js";

await patchConfig(home, { llm: { temperature: 0.2 } });
// writes back to home.configFile, preserving comments + ordering
```

## Internal layout

| File         | Purpose                                                                 |
|--------------|-------------------------------------------------------------------------|
| `paths.ts`   | Resolve `~/.<agent>/memos-plugin/` (and all sub-paths). Single source.  |
| `defaults.ts`| The complete default config tree (matches the schema).                  |
| `schema.ts`  | Typebox schema → JSON Schema (also published to `templates/`).          |
| `yaml.ts`    | Read YAML with line-precise errors.                                     |
| `writer.ts`  | Deep-merge + write YAML preserving comments and ordering.               |
| `index.ts`   | `loadConfig`, `resolveConfig`, exports.                                 |

## Edge cases / gotchas

- **First boot with no config file** — we don't crash; we log a warning and
  use defaults so the agent's first turn still works. The viewer's *Settings*
  page can then create the file via `PATCH /api/config`.
- **Schema drift after upgrade** — extra unknown keys are kept verbatim
  (forward-compatible). Removed keys log a warning and are passed through to
  defaults.
- **chmod 600** — writer always re-applies after writing, so the file never
  becomes world-readable accidentally.
- **API keys in viewer** — `GET /api/config` redacts secret fields before
  returning to the browser; only the on-disk YAML has the raw values.
