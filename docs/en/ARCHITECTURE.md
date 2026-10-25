# Architecture and security model

[简体中文](../ARCHITECTURE.md) | [English](ARCHITECTURE.md)

## Boundaries

The tool is an independent Git repository. Target roots come from local configuration. Tool code, caches, and launch scripts remain in the tool directory. Tests simulate changes in temporary targets owned by the tool; authorized targets are only read. The server binds to loopback and validates Host/Origin. The browser cannot submit arbitrary scan roots or source paths.

## Data pipeline

Configuration authorization → file inventory and hashes → compilation/module context → worker → schema and cross-reference validation → atomic snapshot → graph projections and queries → Chinese exploration interface.

JSON Schema and TypeScript contracts live in `packages/schema`. Workers receive only authorized relative paths and source content. Explicit C# DLL references are read as metadata, without executing assemblies. Python uses `ast`/`symtable` without importing target modules. Analysis runs in child processes with timeouts, input/output budgets, and stderr diagnostics.

IDs derive from the project worktree scope and complete semantic identity, without line numbers. Renaming can produce a new ID and invalidate bookmarks; unreliable historical matching must not imply identity continuity. Relationships, evidence, and file hashes must agree within every snapshot.

## Facts and limitations

`static-confirmed` means that source structure or static semantics within the supported analysis scope have been confirmed. It does not mean execution was observed. Virtual/interface calls can identify a declaration target without determining the actual instance. `inferred` means an inference supported by evidence. There is currently no runtime collector; validation rejects `runtime-verified` output.

System/module aggregation comes from directories, assemblies, and explicit configuration. A language model does not infer responsibilities from code names. Aggregated relationships can be traced back to original edges and evidence. Flows must state their analysis scope and gaps; static field accesses must not be stitched into a complete runtime trace.

## Caching and invalidation

Projects, worktrees, and configurations have separate caches. Source hashes identify changes; debouncing combines bursts of file events, and scans are serialized within a scope. C# semantic changes can affect an assembly and its dependency closure. Python export/import binding changes can affect dependent modules. When a safe local update cannot be established, analysis expands its scope.

Changes to configuration, parsers, schemas, references, or compilation options must invalidate the corresponding caches. HEAD/reference checks and startup inventory verification compensate for missed watcher events. Failures preserve the last valid index. The UI distinguishes empty, analyzing, synchronized, stale, and failed states.

The initial implementation still reads the authorized text inventory twice per scan to verify content hashes. Persistent workers reuse unchanged ASTs; semantic rebinding covers the affected language's merged context. It does not yet read only dirty files or invalidate at symbol dependency granularity. Cache optimization must retain checks for watcher failures, changes that preserve size/timestamps, directory deletion, and scan races.

## Source access

Evidence endpoints read by the current `scope` and `evidenceId`. Relative paths are normalized; every path component rejects symlinks/junctions, and the resolved path must remain within the authorized root. Reads enforce size limits and verify content hashes. Cross-version mismatches must appear as stale evidence instead of presenting old line numbers as current source. The UI renders source as text.

## Further extensions

Priorities include verifiable interprocedural summaries, Python container identity, event lifecycles, explicit protocol adapters, and Unity GUID resource relationships. Additional languages can use the same worker contract. SQLite should be introduced only after scale measurements demonstrate that JSON indexes are insufficient, without adding a database service prematurely.
