# Pure semantic explanation projection

[简体中文](README.md) | [English](README.en.md)

`src/types.ts` defines the public interfaces. `definitions.schema.json` and `overlay.schema.json` independently and strictly validate persisted definitions and worktree overlays. The engine has no file, network, Git, or target-execution capabilities.

- `validateDefinitions` / `validateOverlay` validate schemas, unique identities, complete summary-group coverage, binding origins, relative paths, and history timestamps.
- `semanticRevision` computes a stable JSON fingerprint for a definition or overlay.
- `declarationHash(index,nodeId,sourceTexts)` extracts the exact UTF-16 range from analyzer declaration evidence and hashes it after CRLF normalization. Source text must match the current index; missing current source or multiple declarations returns `undefined`.
- `buildSemanticProjection(index,architecture,definitions,overlay,{sourceTexts,previous})` constructs explanation nodes, raw-fact mappings, call paths with every hop retained, and summary aggregation.
- `semanticBundle`, `semanticReverse`, and `semanticReviewFingerprint` expose the current flow, reverse code mappings, and the basis for local reviews.

Bindings select an explicit primary declaration without automatically absorbing parameters, fields, or every child callback. `implementation` and `context` are separate; the same source may map to multiple explanation steps. Ambiguity and invalidation preserve human text and require review.

Local review fingerprints include explanation definitions, bound declaration text, relevant quotes, and relationship facts. They exclude global source revision, whole-file hashes, and absolute line numbers. Unchanged neighboring methods can keep confirmation; changes to a bound method invalidate it. After an original anchor's file hash becomes stale, it can produce new evidence only if its complete quote appears exactly once in current source and lies within the matched declaration. Original model anchors are not changed.

Call paths use real directed `calls` at every hop and preserve original confidence, dispatch, and analysis limitations. Only original `static-call` transitions can receive call confirmation. Protocol, cross-request, and narrative relations do not become execution order through text edits or human review. Source positions support positional narration, without proving runtime order. Indirect paths are limited to four hops and 200 visited call edges; reaching the budget is explicitly reported.

Summary edges aggregate existing detail relationships only. Counts/descriptions retain internal group relationships and control boundaries. `codeNodes`/`codeEdges` preserve every mapped fact; `codeGraph` renders at most 80 nodes and marks truncation. The original fact index is not modified.

When a source flow adds, removes, or changes content, uncovered steps/transitions produce explicit warnings. The complete source-flow structure enters the overall fingerprint. `previous` supplies change sets and deleted-transition diagnostics. Without a previous snapshot, persisted reviews still detect changes through the current overall fingerprint; the engine does not guess the structure before deletion.

Validation, from the repository root:

```powershell
node --import tsx --test tests/semantic-model.test.ts
```
