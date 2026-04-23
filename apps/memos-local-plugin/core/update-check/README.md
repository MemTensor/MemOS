# `core/update-check/`

> Periodic check for newer plugin versions on npm. Surfaces a notice in
> the viewer's **Overview**; never auto-updates.

## Behaviour

1. At plugin boot, schedule a background check 30 s after startup.
2. Fetch `https://registry.npmjs.org/@memtensor/memos-local-plugin` with
   a 10 s timeout and no auth.
3. Compare `latest` dist-tag to the running `package.json` version.
4. When a newer version is available, emit an `update.available` event
   and write a one-line note to `logs/app.log`. The viewer's overview
   endpoint reads this note and renders a banner.
5. Re-check every 24 h while the plugin is alive.

## Disablement

- `updateCheck.enabled: false` in `config.yaml` turns the whole loop off.
- If the registry fetch fails, we log at `debug` and retry on the next
  24 h tick — never at a shorter interval (avoid hammering npm).

## Tests

- `tests/unit/update-check/` — timer wiring + version-compare logic.
- The fetch function is injected so tests can stub the registry response.
