# Local query and presentation protocol

[简体中文](README.md) | [English](README.en.md)

Public types are defined in `src/types.ts`. `presentation.schema.json` strictly limits unknown fields, reference formats, text lengths, arrays, and payload budgets. `src/index.ts` exports `presentationSchema`, `entityRefSchema`, `validatePresentation`, `validateEntityRef`, and `controlError`, whose errors carry `code`/`statusCode`.

`AnalysisPresentation` expresses presentation intent, without creating analysis facts. Every `semantic` reference requires `flowId`. Field context determines whether a reference is a node or an edge; server queries validate it against the real snapshot. Business entities retain logical IDs in the original intent; `ResolvedPresentation.highlights.architecture*` converts them to actual canvas IDs.

`BridgeQueryService`, in `apps/server/src/bridge-query.ts`, reuses `IndexManager`, `ArchitectureService`, and `SemanticService` without scanning or modifying targets. `begin_analysis` returns a handle valid for the current revisions for ten minutes. At most 16 handles share the fact index and lookup tables. Changes to the source index, architecture/semantic definitions, authorization configuration, or TTL produce `STALE_SNAPSHOT`. There is no historical source replay, and current source is not substituted for an old snapshot.

Supported modes: a `code` target accepts only `viewMode=code`; `systems` and `technical` accept only `explanation`; an existing `flow` supports all three modes. Explicit references hidden by a flow's canvas mode are rejected. Before switching modes, the tool layer must complete all corresponding mappings in the same snapshot. Summary granularity permits real detail-node references; the frontend expands their parent group locally.

Code targets support real code chains without predefined flows. All explicit endpoints, original relationships, and registered paths must be presented. More than 80 nodes or 200 explicit relationships produces `PRESENTATION_TOO_LARGE`; bounded-neighborhood truncation is clearly reported. System/technical references that cannot be displayed together at one real hierarchy level are rejected. Flow references must belong to that flow's mapping.

`get_call_paths` traverses only original directed `calls`, with at most four hops and 200 visits. Server-registered `pathId` values are valid only in their owning snapshot. Paths establish static symbol reachability, without proving a particular runtime call stack, path-condition satisfiability, or complete data flow. `reading-order` means reading order only. Protocol relationships, inferences, dynamic dispatch, and explanation text are not upgraded to execution facts.

Validation, from the repository root:

```powershell
node --import tsx --test tests/bridge-query.test.ts
```
