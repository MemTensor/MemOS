# templates/

These files are copied into the user's runtime home (`~/.<agent>/memos-plugin/`)
by `install.sh` / `install.ps1`. They are **not** read by the running plugin —
the plugin always reads the actual user files at runtime.

| Template                     | Copied to                                   | Overwritten on re-install? |
|------------------------------|---------------------------------------------|----------------------------|
| `config.openclaw.yaml`       | `~/.openclaw/memos-plugin/config.yaml`      | No (unless `--force-config`) |
| `config.hermes.yaml`         | `~/.hermes/memos-plugin/config.yaml`        | No (unless `--force-config`) |
| `README.user.md`             | `~/.<agent>/memos-plugin/README.md`         | Yes (it's just docs)        |

Editing rules:

- `config.*.yaml` must include **every** field with a sensible default and a
  short comment. Sensitive fields (API keys, tokens) MUST be present (empty
  string is fine) so users can fill them in by hand without guessing names.
- These templates are the source of truth for the JSON Schema in
  `core/config/schema.ts`. If you add a field, add it in both.
- The runtime config writer (`core/config/writer.ts`) preserves user comments
  and field order, so user customizations survive future template updates.
