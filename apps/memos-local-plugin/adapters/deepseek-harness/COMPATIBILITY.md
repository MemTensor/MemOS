# DSH compatibility diagnosis and validation

Validated on 2026-10-29, macOS arm64, Node.js 25.1.0, npm 11.6.2,
pnpm 10.21.0. Scope: the local plugin; the Cloud plugin is separate.
Related: MemOS issue #2520 and PR #2541.

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
