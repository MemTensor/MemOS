# Codex user content normalization

The adapter normalizes Codex content before persistence. The viewer and cloud
upload must consume this canonical message, rather than the original host prompt.
`normalizeCodexContent` returns `unresolved` when a recognized envelope cannot be
unpacked safely. Callers must quarantine that turn instead of uploading its raw
wrapper. `codexRecordRaw` keeps event/turn identity while projecting the cleaned
message into the raw event; it does not keep a second copy of the original prompt.
Image payload removal is a separate shared boundary; this module preserves image
parts for that boundary and does not read attached files.

## Evidence and scope

The formats below were checked against the installed desktop app on 2026-11-18:
`/Applications/ChatGPT.app/Contents/Resources/app.asar`, prompt context builder
`CS`, comment renderer `CC`, and prompt delimiter module `20885` in the bundled
`early-bootstrap` files. The rollout format also carries
`internal_chat_message_metadata_passthrough.content_item_kinds` and parallel
`content_item_metadata[].provenance.type`. A `user.text` part can still contain an
entire host-generated envelope; provenance alone does not separate its contents.

| Source structure | Canonical representation |
| --- | --- |
| Non-user content kind or provenance; encrypted content | Removed before text parsing |
| Files mentioned | Non-image file references; attachment instructions removed |
| Files pasted | File references and uploaded text preview as quoted context; a complete pasted-only envelope ending with the native request-in-pasted-text notice does not require a separate request delimiter |
| Application/appshot | Host app context removed; explicit request retained |
| Selected text, including file selection JSON | Quoted selection and user annotation |
| Response annotation JSON | Quoted earlier response text and user annotation |
| Diff/browser comments | `Comment:` and `Additional user guidance:` text; structured user control changes |
| Prior/referenced Codex or ChatGPT conversation JSON | Quoted reference data, without generated read-thread instructions |
| MCP app context | Quoted application context, not a user request |
| Page, artifact target, worktree, PR checks/conflicts/repair | Host handling instructions removed; explicit request retained |
| Bounded page-comment context | Host context removed; following explicit request retained |

The parser recognizes exact, anchored outer section delimiters plus a complete
`## My request:` or `## My request for Codex:` boundary. It tracks fenced examples,
JSON strings/containers, and appshot/annotation/page-context tags. It does not use
regular-expression keyword or title removal. Standalone prose, quoted template
names and code examples remain user text. The actual request is opaque, so even
unfinished JSON or code in a request remains intact.

## Conservative cases

A malformed known envelope, unsupported comment shape, invalid embedded JSON or
multiple unquoted request boundaries is unresolved. Plain text cannot prove
whether an exact, complete host-envelope imitation was typed manually; the parser
uses source provenance and the complete known grammar where available. A literal
unquoted second request delimiter is deliberately quarantined rather than guessed.

This is not a claim to recognize every future host template. The desktop prompt
builder can append dynamic context and restored context, and plugin-provided MCP
context is arbitrary data. New wire formats need observed fixtures and an explicit
parser update. Unknown ordinary user prose is retained; it is not discarded merely
because it contains a heading, path or instruction-like wording.

## Storage and historical data

New ingestion normalizes the source message before saving either the canonical
record or the incremental reader state. Reader version 2 replays older cursors.
Hook receipts retain only discovery and execution identity fields. All agent
image payloads pass through the shared structural image sanitizer; the viewer
renders image references as text only.

Opening a store sanitizes existing traces (including detached Codex records),
batches, receipts and reader states. Batch IDs, upload attempts and accepted
states remain intact. A changed snapshot with an earlier send attempt is blocked
until its previous result is reconciled; it is not silently sent again. Source
fingerprints are invalidated and rebuilt from rollouts rather than inferred from
a canonical record. Missing sources remain explicit capture gaps.

The existing `repair-codex` command defaults to preview. Apply requires the local
service to be stopped and holds its repair lock. It creates a logical copy in
memory, sanitizes it before writing any new backup, replays sources in a temporary
database, then replaces the database only after successful replay. The compacted
file removes old free-page remnants as well as live image payloads. The new backup
is already sanitized and cannot restore excluded templates or images. Original
host rollouts, earlier backup files and previously uploaded cloud data are not
rewritten by this local repair.
