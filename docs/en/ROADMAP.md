# Planned implementation order

[简体中文](../ROADMAP.md) | [English](ROADMAP.md)

> This document preserves its planning context. Statements about delivered work describe the original planning record and are not new acceptance results. Prioritize future work against the current implementation and review findings.

The planning baseline had delivered the second-stage MVP, with early support for C# field reads/writes, limited events, and multi-level call queries. Further work should prioritize evidence quality and improvements to understanding.

1. More precise incremental I/O: dirty paths and protected content caches; handle changes that preserve size/timestamps, `unlinkDir`, watcher failures, and scan races. Retain forced hashing in `full`/`verify` and prove consistency with full scans.
2. Compilation context: model asmdef groups and `CompilationReference`; validate defines, platforms, references, and accessibility to reduce merged-context limitations.
3. An interprocedural HP explanation: Python container identity and call summaries, with explicit mappings at both HTTP/JSON endpoints. Each edge retains its own level of proof; matching field names must not create connections automatically.
4. Callbacks and state: explicit delegate-passing summaries, subscription lifecycles, state guards, and transitions, without guessing arbitrary dynamic targets.
5. Resource relationships: Unity text YAML and `.meta` GUID/fileID, retaining limitations for dynamic loading and binary content.
6. Broader acceptance: 200% browser zoom, more window sizes and keyboard paths, large-project performance, and recovery from corrupt caches/power loss. Introduce SQLite only when scale tests demonstrate the need.

Every extension needs golden expectations, real-project evidence, and regression coverage for existing exploration flows. Relationship counts alone must not be presented as an accuracy improvement.
