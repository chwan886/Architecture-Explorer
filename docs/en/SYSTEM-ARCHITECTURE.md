# Systems, modules, and collaboration

[中文](../SYSTEM-ARCHITECTURE.md) | English

## From the overview to source code

The Systems overview groups code by business responsibility. Candidate systems can span C# presentation code, protocol contracts, and Python rules; a directory is not automatically a business system.

1. At L1, click a system to inspect its responsibility, features, key data, inputs, outputs, and human review status.
2. Double-click it, or choose Enter system, to see L2 modules and their collaboration.
3. Enter a module to see L3 components. A component opens the existing code map.
4. In the code map, explore methods, calls, reads, writes, and source evidence at L4. The business ownership panel returns to the responsibility map; Return to system architecture preserves the architecture context.

Breadcrumbs return to any level. Back restores the selection and evidence. Global search retains code search, while the system sidebar filters responsibility names. Unclassified source remains accessible through the paginated Unclassified list below the canvas.

## Two independent perspectives

Technical architecture is generated from assembly definitions and source groups in the current fact index. Assemblies, Python modules, and resource entries depend on the authorized source, without fixed directory or assembly names. Edges come from actual references, calls, interfaces, events, reads, and writes. Layer names do not establish dependency direction.

The Systems overview comes from a separate model maintained in this tool. The included demo defines four candidate responsibilities: coordination, calculation, state, and display. Your project can define different systems and modules. These candidates are source-backed suggestions; they start without human confirmations.

Aggregated edges retain original relation IDs, evidence, conditions, and confidence counts. Select an edge to browse its paginated members and open either endpoint. Category filters recalculate the corresponding members. Field access is labeled as reads or writes; it does not establish data transfer between systems.

## Initial flows

Flow definitions organize source entry points, rules, transactions, snapshots, and display steps into phase-by-responsibility swimlanes. Each step links to source, and each transition has its own status:

| Label | What it establishes |
| --- | --- |
| Static call confirmed | A statically confirmed `calls` edge exists in the current index; execution on a particular run is not guaranteed. |
| Source supported | Valid anchors at both ends in the same file support a source narrative; this is not complete control flow. |
| Order unverified | HTTP, separate requests, or a human narrative do not establish execution order; runtime evidence is still needed. |

The included demo separates the entry point, calculation, and state application into three steps, joined by two real C# static calls. Your flows may include separate requests or cross-language associations; those remain unverified rather than being depicted as one call stack. Select a transition below the swimlanes to inspect branch conditions and limitations.

There is no runtime collector. Confirming a flow description does not upgrade an unverified relation. Read/write descriptions combine curated anchors and static facts; they are not automatic interprocedural data-flow analysis.

## Persistent models and updates

Responsibility definitions live in `architecture/models/<projectId>/model.json`; their independent schema is `packages/architecture-model/model.schema.json`. Project IDs refer to authorized configuration entries, without embedding scan roots. A new project without a model returns an empty business model; technical and code views remain available.

The model has three independent parts:

- Definitions: systems, modules, memberships, flows, and anchors.
- Reviews: target, Worktree scope, fingerprint, decision, and timestamp.
- Generated results: projections computed from source and model, stored in scoped `.cache` directories and excluded from Git.

`owner` expresses a unique primary responsibility. `participant` and `shared` retain associations without creating dependencies between every participating system. Conflicting owners, missing symbols, ambiguous names, and changed anchors produce diagnostics.

The Model button opens a JSON editor. Saving uses strict validation, a current-index allowlist, complete source lines and content hashes, an interprocess lock, optimistic revision checks, and atomic replacement. Conflicts preserve the draft; reload and merge the current version. Reviews of a system definition, individual membership, and flow description are independent and can be withdrawn.

The existing indexer watches source changes. A source revision change regenerates aggregated relations; a model revision change only reprojects and does not invoke analyzers. Scanning does not overwrite human records. A fingerprint mismatch requires review. Worktrees do not share confirmation decisions; evidence always comes from the current authorized directory.

Website saves notify other pages on the same service through SSE. After editing model files externally, reload the architecture model. System views have an independent `viewRevision`. Stale details, relations, or evidence requests return 409; the page clears old evidence and requests a reload.

## Maintenance and limitations

The architecture upgrade reuses analyzers, schemas, graph components, and code navigation; responsibility projection is an additional package. Models do not invent unsupported event, initialization, or asset relations. Unclassified entities retain their code facts. Changed source hashes require anchor maintenance; old line numbers cannot silently become new evidence.

See the repository README for running, scanning, and full tests. Mutation and deletion tests use temporary tool fixtures without external private source. Model schema and projection versions are separate from fact-index versions. Changing a model or source version invalidates derived projections.
