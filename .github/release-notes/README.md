# Repository release notes

For the complete MemOS and embedded local-plugin release flow, safeguards, and recovery guide, see [MEMOS_LOCAL_PLUGIN_RELEASE_FLOW_ZH.md](./MEMOS_LOCAL_PLUGIN_RELEASE_FLOW_ZH.md).

Release branches may include an optional MemOS release overview at:

```text
.github/release-notes/vX.Y.Z.md
```

For example, `dev-v2.0.30` may add `.github/release-notes/v2.0.30.md`.

The `MemOS Release — Publish` workflow reads the file from the exact release target commit and places it before GitHub's generated `What's Changed` section. Keep it short and product-facing. Start with a section such as `## Highlights`; do not copy commit lists that GitHub already generates.

This file is optional. It does not decide whether the embedded MemOS local plugin is released, does not replace path-filtered git evidence, and must not contain Doc Agent payloads, binding markers, tokens, internal service URLs, or other credentials. Local-plugin Plugin tab copy still comes from `apps/memos-local-plugin/**` evidence and must pass source-ref, bilingual, coverage, and repair validation.
