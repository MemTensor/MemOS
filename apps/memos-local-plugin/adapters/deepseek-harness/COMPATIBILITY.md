# DSH compatibility diagnosis and validation

Validated on 2026-10-29, macOS arm64, Node.js 25.1.0, npm 11.6.2,
pnpm 10.21.0. Scope: the local plugin; the Cloud plugin is separate.
Related: MemOS issue #2520 and PR #2541.

## DSH 0.2.2-rc.1 through rc.5 validation — 2026-11-19

This update incorporates PR #2614 in PR #2632 and was tested on macOS arm64,
Node.js 25.1.0, and npm 11.6.2. All five published 0.2.2 release candidates
are now explicitly admitted by the six optional host-service peers.

The intermediate-version regressions first failed in six places. npm's
default peer checks rejected rc.2, rc.3 and rc.4, and their fixtures selected
Cordis ~4.0.5 and the 0.2.1-rc.3 session codec. Each of these hosts requires
Cordis ~4.1.0. The overrides table now pins all five 0.2.2 fixtures to Cordis
4.1.0 with each host's matching codec. The fixture also checks plugin and
host Cordis peer requirements. Runtime adapter changes were unnecessary
after these dependency-selection fixes.

The peer declarations list rc.1, rc.2, rc.3, rc.4 and rc.5 individually.
The package regression continues to reject rc.6, stable 0.2.2 and 0.3.x
under npm's default semver evaluation.

Verification output:

```text
make format: All checks passed! / 642 files left unchanged
npm test: Test Files 192 passed (192)
          Tests 1669 passed | 3 skipped (1672)
pytest apps/memos-local-plugin/tests/python -q: 143 passed in 5.64s
npm run lint: passed
npm run build:package: passed
npm run lock:check: SQLite 13.0.3 lock metadata verified
npm run test:dsh-compat -- 0.2.2-rc.2 0.2.2-rc.3 0.2.2-rc.4:
  PASS all 3 DSH versions
npm run test:dsh-compat: PASS all 10 DSH versions
```

All ten real host stacks passed type checking, a production TypeScript
build, and 71 adapter tests each. The matrix covers 0.1.0-rc.6, 0.1.7-rc.2,
0.2.0-rc.2, 0.2.1-rc.2, 0.2.1-rc.3, and every release from 0.2.2-rc.1
through 0.2.2-rc.5. The matching host packages were fetched from npm.
Existing non-host build tools and unchanged native bindings were reused.

The first matrix attempts were interrupted by npm/Node registry connection
timeouts. The successful runs used an explicit temporary Undici proxy
dispatcher for the machine's system HTTPS proxy, with loopback traffic
bypassing it. No proxy dependency was added to the plugin.

The official rc.5 loader uses semver includePrerelease enabled. A real
dump-config comparison showed that the older >=0.2.1-rc.2 <0.2.2 comparator
already admits rc.5 at startup. The explicit prerelease declarations address
npm's default peer-evaluation mismatch.

### Real Web startup checks

Official DSH CLI packages were installed separately with lifecycle scripts
disabled. An npm-packed local plugin runtime was loaded into fresh Web
profiles with synthetic local settings, telemetry disabled, and
failOnStartupError enabled.

| DSH version | API/build/71 adapter tests | Actual macOS Web startup |
| --- | --- | --- |
| 0.2.2-rc.1 | Passed | Unverified |
| 0.2.2-rc.2 | Passed | Passed |
| 0.2.2-rc.3 | Passed | Passed |
| 0.2.2-rc.4 | Passed | Passed |
| 0.2.2-rc.5 | Passed | Passed in the initial rc.5 validation |

For rc.2, rc.3 and rc.4, the composed profile contained the MemOS row with no
version exemption. Actual startup created SQLite storage and returned HTTP
200 from the Viewer health endpoint with agent deepseek-harness. SIGINT
stopped each Web process with exit code 130. The prior rc.5 smoke produced
the same results.

### Fresh installation and real local-model round trip

A fresh official DSH 0.2.2-rc.5 CLI was installed using npm with normal
dependency lifecycle scripts. The branch source was built and packed with
npm pack, including its prepack build. The local tarball retained the
branch's package version 2.0.16-beta.1 and was identified by its branch
contents rather than an npm release tag.

The first actual installer run failed with ERR_PNPM_IGNORED_BUILDS for
esbuild@0.28.2. The tarball's tsx range ^4.21.0 resolved to 4.23.15 under
pnpm, which ignores the tarball's npm lock. A failing regression reproduced
the manifest/validated-version mismatch. Pinning tsx to the already locked
4.21.0, with both lock importers synchronized, resolved the installation
failure while retaining the existing reviewed script policy.

The rebuilt source tarball was installed into a second fresh DSH home using
the official Unix installer and an isolated pnpm 11.7.0. Actual installed
versions were tsx 4.21.0, esbuild 0.27.7, better-sqlite3 13.0.3 and
onnxruntime-node 1.24.3. The installer's SQLite write/read probe and bundled
ONNX CPU backend probe both passed.

A real Ollama-backed headless test used existing local qwen2.5:0.5b and
nomic-embed-text models. The MemOS auxiliary LLM calls used DSH's host-model
bridge, and the embedding endpoint produced 768-dimensional embeddings.
For the small local model, the test profile retained the MemOS tools and
disabled unrelated tool providers. The initial full-tool profile exceeded
Ollama's 4096-token context and produced off-topic answers, so that run was
not used as evidence of answer correctness.

The successful test created a fresh memory directory and separate DSH
sessions/processes for each prompt:

1. Store the synthetic fact that Project Orchid-Z91 uses port 47381.
   The model replied SAVED and the first trace was persisted.
2. Restart DSH into a new session and ask for the project's port without
   supplying the number. The model answered Project Orchid-Z91 port 47381.
3. Ask the model to call memos_search. The real tool call completed, returned
   the two earlier memories, and the final answer included port 47381.

The compressed V4 session logs confirmed a producer-owned MemOS recall
message containing memos_context and the correct port in the second and
third sessions. SQLite had three persisted traces with embedding vectors,
and PRAGMA integrity_check returned ok. Each successful headless turn
exited 0 and its lightweight capture reported warnings=0. Ollama's server
log also recorded HTTP 500 responses during auxiliary activity, while
these turns and captures completed successfully.

The headless --json stdout also includes MemOS core log lines. This test
parsed the JSON event lines separately and preserved the complete output.
Strict NDJSON-only stdout is an outstanding integration limitation.

These tests used package-manager-installed dependency trees and synthetic
local inputs. The temporary Ollama server was stopped after validation.

### Remaining verification and release scope

Cloud-provider authenticated conversations, packaged Desktop applications
on macOS, Windows and Linux, live model downloads, and production-profile
upgrades remain unverified. Fresh installation was exercised on macOS with
DSH rc.5, Node.js 25.1.0 and pnpm 11.7.0. Other platform/runtime installation
combinations and full-tool agent answer quality remain unverified.
The Cloud plugin and other DSH previews are outside this validation.
These source changes have not been published to npm.

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
