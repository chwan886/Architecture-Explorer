# Semantic explanations and code graphs

[中文](../SEMANTIC-GUIDE.md) | English

Open Business flows in the top navigation to browse flows defined by the current project's model, starting with concise Chinese explanations. The included demo provides one calculation and state-application flow; other projects need not adopt its names, steps, or counts. Independent requests and mutually exclusive branches are not treated as a definite sequence. Original flow evidence still opens the swimlane board. Systems, technical layers, and the code map share the same index.

## Understand a flow and inspect its implementation

- Business explanation shows the main steps. Choose Detailed or expand a group to inspect its steps, conditions, loops, and asynchronous boundaries. Local expansion uses real detail edges without inventing connections.
- Code implementation shows mapped methods, callbacks, and actual relations. Compare displays explanation and code together; selecting either side highlights every mapping on the other. A method can contribute to several explanations, and one step can map to several implementations.
- The Inspector shows purpose, inputs, outputs, processing, state changes, mappings, and evidence. Select a semantic edge to inspect underlying relations, directed call paths one hop at a time, and confidence. HTTP, protocol matches, and other relations without static proof remain unverified.
- Open an implementation in the original code map to continue exploring calls, reads, writes, and source. Return to the current explanation afterward. Related business explanations in the code map provide reverse navigation. Navigation history, details, and evidence selection remain consistent within the code layer.

Collapsing, display budgets, and filters can hide entities or relations; the page reports this. Absence of a proven call does not establish absence of a business association. A static call does not guarantee runtime execution or prove complete runtime data flow.

## Human maintenance

Initial explanations are source-backed candidates. `curated` means source curation, not user confirmation or runtime verification. Review status is independent of the confidence of code facts; confirming text does not upgrade unverified order.

Edit Chinese titles, responsibilities, inputs, outputs, processing, and changes; merge or split summary groups; confirm, reject, or withdraw reviews. Summary groups must cover every detail step exactly once. Group operations preserve detailed logic and control boundaries. Saves use optimistic version checks. Conflicts between windows retain drafts; read the latest server model before merging.

Rule candidates use deterministic local templates to reorganize existing content. Preview them before adopting them. They do not overwrite human content automatically, call external AI services, or create new code relations. Previews record the rule source and generator version. Adopted content becomes a human revision while retaining rule notes; base definitions remain separate. A future AI integration should have its own configuration and independent generated-text version storage.

Base definitions live in `architecture/semantics/<projectId>/definitions.json`. Human overrides and reviews live in `architecture/semantics/<projectId>/worktrees/<worktreeId>.json`. The server retains the latest 100 history records. Override files can be committed with the tool for durable maintenance; derived `.cache` files are excluded. Authorized projects and Worktrees have separate overrides, reviews, and caches.

## Updates and invalidation

After the existing watcher updates the code index, the semantic view resolves mappings against that index and compares local fingerprints. Unchanged methods and explanations retain their review decisions. Changes to a bound method's content, parameters, control logic, relations, or anchors require review. The initial implementation hashes the full AST declaration text, including method bodies. This is conservative but unaffected by neighboring methods or line shifts.

When a whole-file hash changes, an old quotation can be relocated only if it matches completely and uniquely within the bound declaration. New evidence uses the current file hash without rewriting the original architecture anchor. If no unique match exists, human text is retained and flagged for review. If a uniquely resolved implementation changed, read the current source, explicitly adopt its new declaration baseline, and review it again. Invalid anchors or ambiguous bindings require correction in the architecture model; matching names alone cannot confirm them.

Revalidate recomputes local mappings and evidence without rewriting human text. Reads and edits check source, view, and overlay versions. Stale views return 409 and clear old source selections to prevent mixing code and explanation snapshots.

Each index change still recomputes lightweight projections of all defined flows. Local fingerprints restrict review invalidation; the underlying index does not yet provide whole-program symbol-level incremental analysis. Scanning does not regenerate human prose. Explicit selectors must be maintained in base semantic definitions after symbol moves or renames; there is no automatic name-similarity migration. Runtime traces, complete CFGs, and automatic cross-HTTP JSON value propagation are not provided.

## Reproducible checks

Run from the tool directory; the default configuration is `config/local.json`:

```powershell
powershell -ExecutionPolicy Bypass -File Tools/explorer.ps1 -Task Test
powershell -ExecutionPolicy Bypass -File Tools/explorer.ps1 -Task Typecheck
powershell -ExecutionPolicy Bypass -File Tools/explorer.ps1 -Task Build
pnpm verify-semantics
powershell -ExecutionPolicy Bypass -File Tools/explorer.ps1 -Task Dev
```

With portable Node, the equivalent verification command is `.tools/node-v24.22.0-win-x64/node.exe node_modules/tsx/dist/cli.mjs Tools/verify-semantics.ts`. It reads an existing authorized index and source, validates mappings and paths, and reports step, relation, and review counts. Without a cache, run Scan first. Mutation tests use tool-owned synthetic `.tmp` fixtures and require no external private project.
