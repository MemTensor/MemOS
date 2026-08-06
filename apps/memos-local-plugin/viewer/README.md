# `viewer/` — MemOS Local viewer (Vite + Preact)

The viewer is the user-facing dashboard for the MemOS Local memory
plugin. It renders the live state of the algorithm core: sessions,
episodes, traces, skills, feedback, events, and logs. It is served by
the plugin's own HTTP server (see `../server/`) under `/ui/` and is
also publishable as a standalone static bundle for embedding in other
tools.

The viewer has three design goals, in order of importance:

1. **Stay out of the algorithm's way.** It is a read-mostly dashboard.
   All write actions are narrow (explicit feedback, skill retirement,
   api-key persistence) and require a confirm step.
2. **Be minimal and auditable.** ~9 kB of framework (Preact +
   signals), zero CSS frameworks, a single-file route registry, and
   plain `fetch`/`ReadableStream` for transport.
3. **Look good.** Tokens → semantic layer → components; aesthetic
   type scale, strong dark-mode, consistent motion, WCAG-compliant
   contrast.

## Layout

```
viewer/
├── index.html                # Vite entry
├── src/
│   ├── main.tsx              # Preact render root
│   ├── api/
│   │   ├── client.ts         # `fetch` wrapper with api-key + uniform errors
│   │   ├── sse.ts            # SSE client w/ fetch-streaming + reconnect
│   │   └── types.ts          # Re-exports from `agent-contract/`
│   ├── stores/
│   │   ├── router.ts         # Signal-backed hash router
│   │   ├── theme.ts          # light / dark / auto
│   │   └── health.ts         # `/api/v1/health` polling signal
│   ├── styles/
│   │   ├── tokens.css        # Palette + semantic tokens (dark/light/auto)
│   │   ├── layout.css        # Reset + app-shell grid
│   │   └── components.css    # Buttons, cards, pills, tables, streams
│   ├── components/
│   │   ├── App.tsx           # Shell: sidebar + header + content
│   │   ├── Sidebar.tsx       # Nav with sections
│   │   ├── Header.tsx        # Title + health dot + theme switch
│   │   ├── ThemeSwitch.tsx   # Auto → Light → Dark cycling button
│   │   └── ContentRouter.tsx # Switches between views by `route.value.path`
│   └── views/
│       ├── OverviewView.tsx  # Metrics + live event tail
│       ├── EventsView.tsx    # Filtered live CoreEvent stream
│       ├── LogsView.tsx      # Filtered live LogRecord stream
│       ├── SessionsView.tsx  # Episode list + trace timeline
│       ├── MemoriesView.tsx  # Three-tier search + ranked hits
│       ├── SkillsView.tsx    # Skill library + retire action
│       ├── FeedbackView.tsx  # Explicit feedback form
│       └── SettingsView.tsx  # Theme / api-key / system info
```

## Data model

The viewer speaks only two protocols to the core:

1. **REST over HTTP.** JSON bodies, `Authorization: Bearer <key>` or
   `x-api-key`. See `../server/README.md` for the route list.
2. **SSE streams.** `/api/v1/events` and `/api/v1/logs` using fetch +
   `ReadableStream`. This keeps SSE usable even when an API key is
   required (browsers can't attach headers to native `EventSource`).

All incoming payloads are already typed: `viewer/src/api/types.ts`
re-exports the DTOs from `agent-contract/` so the viewer and the
algorithm core share the same types by construction.

## Visual design

### Tokens

Raw palette (`color-slate-*`, `color-violet-*`, …) → semantic tokens
(`--bg`, `--fg`, `--accent`, …) → component rules. Three themes:

- `light` — default
- `dark`  — deep navy with violet accent
- `auto`  — respects `prefers-color-scheme`, overridable per visit

Themes persist in `localStorage` under `memos.theme`.

### Type scale

Inter for UI, JetBrains Mono for code. Seven-step scale from 11 px
(`--fs-xs`) to 26 px (`--fs-2xl`). Line-heights follow W3C
recommendations (1.15 / 1.45 / 1.7).

### Motion

`--dur-fast` (120 ms) for hover/focus, `--dur-med` (220 ms) for layout
shifts. All with a smooth overshoot-free easing (`cubic-bezier(0.16, 1,
0.3, 1)`).

## Running the viewer

### In dev

```bash
# From apps/memos-local-plugin
npm run viewer:dev
```

Vite serves from `http://localhost:5173` with HMR. The viewer calls
`/api/v1/*` paths — dev mode assumes the core HTTP server is running
on the same host (configure with `VITE_API_BASE_URL` env var if you
need to proxy to another origin).

### In production

```bash
npm run build:viewer
```

Outputs `viewer/dist/` which the plugin's HTTP server serves from `/ui/`.
The bundle is < 60 kB minified+gzipped (Preact 10 + signals + viewer
code).

## Testing

Vitest covers three pieces:

- `tests/unit/viewer/api-client.test.ts` — verb helpers, error shape,
  api-key propagation.
- `tests/unit/viewer/sse-client.test.ts` — SSE frame parsing, api-key
  header forwarding, `close()` semantics.
- `tests/unit/viewer/router.test.ts` — hash parsing, `navigate()`
  roundtrip.

Run:

```bash
npm test -- tests/unit/viewer
```

All three files use `globalThis` shims for `window`/`localStorage`
rather than jsdom, keeping the viewer test surface lightweight.

## Accessibility

- Every button has a descriptive `aria-label` when its visible text is
  icon-only.
- Navigation uses `aria-current="true"` for the active item.
- Dialogs set `role="dialog"` and `aria-modal="true"`; the Skill
  retire action confirms with `window.confirm` so the flow works with
  screen readers.
- Color contrast: all foreground/background token pairs clear
  WCAG-AA at normal text sizes; `color-scheme` meta ensures form
  controls render with correct native theming.

## Extension points

Adding a new view:

1. Drop `viewer/src/views/NewView.tsx`.
2. Register it in `ContentRouter.tsx`.
3. Link it from `Sidebar.tsx` (`NAV` array).
4. If the view needs a new endpoint, add it to `../server/routes/`
   and re-use `api.get/api.post` with the relevant DTO.

Avoid adding routing libraries. The signal-backed hash router is ~40
lines and covers 100 % of our routing needs without dragging in a
framework.
