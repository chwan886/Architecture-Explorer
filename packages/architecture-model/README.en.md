# Business architecture models and projections

[简体中文](README.md) | [English](README.en.md)

This package derives business systems, module collaboration, and flow explanations from the existing fact index. It does not reparse source or change code nodes' lexical `parentId` values.

The service persists human models separately; technical scan caches do not own human decisions. Public types live in `src/types.ts`. `model.schema.json` is a strict standalone JSON Schema; `validateModel` additionally checks references, unique identities, paths, and line ranges.

Main entry points:

- `buildProjection(index, model)` builds a projection for the scope and source/model revisions.
- `architectureView` provides four levels of business navigation and a technical perspective; technical navigation reuses the existing fact graph.
- `entityDetail`, `relationMembers`, and `ownership` expose responsibilities, paginated original relationship members, and code ownership.
- `modelRevision` and `reviewFingerprint` provide independent model revisions and the current review basis.

All exported functions are pure computation. They do not read local files, access the network, persist data, or write to target projects.

## Trust boundaries

Business systems are human definitions; confirming a definition does not bulk-confirm memberships. Only `owner` memberships create system/module relationships. `participant`/`shared` describe participation. Code entities with conflicting primary owners do not generate business relationships.

Unconfirmed or source-changed memberships retain their own state separately from the underlying source relationships. Human classification is not a runtime fact.

Selector fields are combined with AND. `qualifiedNamePrefix` is a literal prefix; `filePathPrefix` respects directory boundaries. Exact names can be narrowed by file, language, and kind.

Matching a class/file expands membership to its source descendants. Selectors cannot authorize external metadata nodes or files absent from the current index.

Each direction has one collaboration summary edge retaining original edge IDs, endpoints, data nodes, evidence, and confidence counts.

Category filtering recomputes members, evidence, primary ownership provenance, and pending state. Filtered relation IDs include `~category=<enum>`; pagination reconstructs that same set. Component/technical navigation adds a verifiable context. Graphs contain at most 80 nodes, pages at most 200 members, with explicit truncation.

A `SourceAnchor` must match a current `index.files` path and hash. Invalid anchors produce review diagnostics; old line numbers do not generate new evidence. The pure computation layer has no source text. Service writes and evidence reads must additionally verify that the quote equals the exact complete source lines, normalizing CRLF.

Review fingerprints include scope, current definitions, source members, and file/anchor hashes, excluding reviews themselves. Confirmation from another worktree does not apply to the current scope. Deleted targets, changed source, and invalid anchors retain definitions and require review. Queries must not mix different model/source index versions.

A flow's `phase` is narrative layout order. `static-call` is supported only when a confirmed real `calls` edge exists between the steps' current members; actual virtual-dispatch implementations remain unverified. `source-order` requires ordered, valid anchors at both endpoints in one file, without proving runtime order. Protocol, multi-request, and narrative relations always remain unverified.

## Validation

From the repository root:

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/architecture-model.test.ts tests/architecture-api.test.ts
```

Model tests use explicit golden expectations. API tests use real Fastify, `IndexManager`, and Python AST analysis, creating an isolated tool root and two synthetic authorized targets inside the tool's `.tmp` directory, without external private projects.
