# DSH compatibility diagnosis and validation

Validated on 2026-10-29, macOS arm64, Node.js 25.1.0, npm 11.6.2,
pnpm 10.21.0. Scope: the local plugin; the Cloud plugin is separate.
Related: MemOS issue #2520 and PR #2541.

## DSH 0.2.2-rc.5 validation — 2026-11-19

This update builds on PR #2614 and was tested on macOS arm64 with Node.js
25.1.0 and npm 11.6.2. npm's `latest` and `next` DSH tags both pointed to
`0.2.2-rc.5` when checked.

The package regression first failed because all six optional DSH service
peers omitted `0.2.2-rc.5`. Running the original PR's matrix with that
version also failed with `ERESOLVE`: it selected Cordis `~4.0.5` while
the published host requires `~4.1.0`.

The fix explicitly admits `0.2.2-rc.5`, preserves the tested `0.2.2-rc.1`,
and uses one overrides table to select Cordis `4.1.0` and each new host's
matching session codec. The fixture checks Cordis against the plugin and
host service peer ranges, including metadata with no optional peers.

The official rc.5 loader uses semver `includePrerelease: true`. A real
`--dump-config` comparison showed that it already loads the original PR
manifest through the older `>=0.2.1-rc.2 <0.2.2` comparator. npm's default
peer evaluation excludes rc.5 under that comparator. The explicit rc.5
peer declaration fixes the package-manager mismatch.

Verification output:

```text
make format: All checks passed! / 642 files left unchanged
npm test: Test Files 192 passed (192)
          Tests 1661 passed | 3 skipped (1664)
pytest apps/memos-local-plugin/tests/python -q: 143 passed in 5.78s
npm run lint: passed
npm run build:package: passed
npm run lock:check: SQLite 13.0.3 lock metadata verified
npm run test:dsh-compat: PASS all 7 DSH versions
```

Each of the seven real host stacks passed type checking, a production
TypeScript build, and 71 adapter tests: `0.1.0-rc.6`, `0.1.7-rc.2`,
`0.2.0-rc.2`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.2-rc.1`, and
`0.2.2-rc.5`. The fixtures installed matching host packages from npm and
reused the checkout's unchanged non-host build tools and native bindings.

A separately installed official DSH `0.2.2-rc.5` CLI loaded an npm-packed
local bundle in a fresh Web profile with no version exemption. Actual Web
startup with `failOnStartupError: true` created SQLite storage and returned
HTTP 200 from the MemOS Viewer health endpoint with agent
`deepseek-harness`. The process was stopped with SIGINT and exited 130.

The Web smoke used synthetic local configuration with telemetry disabled.
Authenticated model conversations, packaged Desktop releases on macOS,
Windows and Linux, fresh native-dependency installation, and live embedding
model downloads remain unverified. This source change is unpublished.

## Diagnosis

The local plugin's six optional host-service peers excluded DSH 0.2.x.
DSH 0.2.1 actively skips an incompatible bundle before mounting any plugin
row. `failOnStartupError: false` cannot help because this check precedes
the adapter's `apply()` function. The V4 message-source fix in 2.0.21 does
not change this version gate.

An independent compile against 0.2.1-rc.3 also failed with:

```text
tools.ts(4,27): error TS2614: Module '"@deepseek-ai/dsh-tools"' has no exported member 'JsonValue'.
```

The fix adds bounded prerelease comparator sets, replaces that moved type
with the equivalent local JSON shape, and aligns the entire development
stack and both lockfiles. The V4 source implementation is unchanged.
The old rc.5 API baseline is no longer declared because its core packages
cannot be retrieved from npm; rc.6 is the installable legacy baseline.

## Regression evidence

Before the manifest change, the package regression suite failed for all
four newly targeted previews: 0.1.7-rc.2, 0.2.0-rc.2, 0.2.1-rc.2/rc.3.
After the change, each of the five API stacks in `npm run test:dsh-compat`
passed type checking, a TypeScript production build, and 71 adapter tests.
The matrix installs the complete matching host peer graph, without borrowing
DSH packages from the checkout. The native session admission/snapshot tests
preserve the producer-owned recall source on the legacy and modern stacks.

Official DSH 0.2.1-rc.3 CLI smoke test: install the published CLI with
`--ignore-scripts` in a temporary directory; create an isolated `DSH_HOME`,
initialize a `compat` profile from `web`, and register a staged local bundle
in `dsh.profile.bundles`. Run `--profile compat --dump-config` with the old
and new peer declarations, holding all other bundle files constant:

| Declaration | Incompatible warning | MemOS row in composed tree |
| --- | --- | --- |
| Old `>=0.1.0-rc.5 <0.2.0` | Yes; exact-version exemption inactive | Absent |
| New bounded ranges | No | Present |

Both commands exit 0: exit status alone cannot detect a skipped bundle.
No version exemption, live profile, credential, or customer session was used.
The installed Desktop 0.2.0-rc.2 loader accepted both declarations, so it
cannot reproduce the newer 0.2.1 startup gate.

Other real command results:

```text
make format: All checks passed! / 630 files left unchanged
npm test: Test Files 191 passed (191)
          Tests 1655 passed | 3 skipped (1658)
npm run lint: passed
npm run build:package: passed (TypeScript and Viewer)
npm ci --ignore-scripts --no-audit --no-fund: added 211 packages
npm ls --all: exit 0, no invalid peers
pnpm install --lockfile-only --frozen-lockfile --strict-peer-dependencies --ignore-scripts: passed
npm run lock:check: SQLite 13.0.3 lock metadata verified
```

The first sandboxed full run failed when HTTP tests could not bind localhost
(`listen EPERM`). The full result above comes from a rerun with local port
access. Package installation scripts were disabled; the unchanged SQLite
13.0.3 native build was reused for testing.

These checks do not constitute a fresh authenticated model conversation on
every Desktop/Web/CLI platform. The compatibility change is unreleased;
installing npm 2.0.21 still has the old startup restriction.
