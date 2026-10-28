# Reviewed OpenClaw cloud plugin Release Notes

This directory is optional. A version-bump pull request may add
`.github/release-notes/v<version>.md` when release owners want to provide the
reviewed GitHub Release body themselves. For example:

```text
.github/release-notes/v0.1.21.md
```

The version in the filename must match all four committed version files. No
special branch name is required. The file must use the same evidence-backed
contract as the former `release_notes` workflow input:

- public `## Changelog` Markdown;
- one hidden `doc-agent-release-notes-json` block containing bilingual items
  and real `source_refs`;
- one exact `<!-- doc-agent: source-id=openclaw-cloud-plugin -->` marker.

The release workflow validates the file. Invalid manual notes fail closed and
cannot publish npm, a tag, or a Draft Release.

The automatic workflow reads this file directly from the immutable merged
commit. It does not copy the Markdown through cross-job outputs and does not
create a version-update pull request.

When this file is absent, the workflow collects immutable git evidence and asks
the configured 106 Doc Agent draft endpoint to generate and repair the same
contract. Do not commit internal URLs, tokens, prompts, or unredacted logs here.
