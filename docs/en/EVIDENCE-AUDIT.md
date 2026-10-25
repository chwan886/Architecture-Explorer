# Evidence auditing and review

[中文](../EVIDENCE-AUDIT.md) | English

`Tools/audit-evidence.ts` checks the existing index, business ownership, and semantic explanations against one source snapshot, producing a reproducible read-only audit. It does not execute the analyzed target, invoke scanning, modify target files, or make human review decisions.

Run from the tool directory:

```powershell
node node_modules/tsx/dist/cli.mjs Tools/audit-evidence.ts --config config/demo.json --project combat-demo --worktree primary
```

Options: `--config` selects tool configuration; `--max-findings` limits detail records (default 500, maximum 10,000); `--max-items` limits checks (default 1,000,000, maximum 5,000,000). A Worktree must be authorized in configuration and have the form `primary` or an actual `wt-<12-character hash>`.

Reports always go to `.cache/evidence-audit/<project>-<worktree>.json` under the configured tool cache. There is no output-path option. Each cache path segment rejects symbolic links and junctions; the cache cannot redirect into the analysis target. Reports contain entity IDs, source-relative paths, diagnostics, and counts, without full source files.

## Interpret statuses independently

| Report item | Meaning | Follow-up |
| --- | --- | --- |
| `rawRelations.calls.static-confirmed` | The analyzer found a static source call. | No individual human confirmation is required; execution on a particular run is not guaranteed. |
| `rawRelations.calls.inferred` | A call has supporting evidence but cannot be statically confirmed. | Prioritize core flows for review and retain the inferred label. |
| `rawRelations.dynamicDispatch` / `dynamic-dispatch` | Non-direct dispatch on `calls`, such as a virtual declaration target. | Parameter metadata such as `declared-parameter`, `argument:*`, and delegate references are not dynamic calls; see `unknown-runtime-target` for unresolved handlers. |
| `rawRelations.byKind.passes` | Total `passes` relations, both confirmed and inferred. | A kind-only total is not a static-confirmation count. |
| `rawRelations.byKindAndConfidence.passes` | Confidence-specific argument/callback bindings. C# declared parameter bindings may be confirmed; dynamic Python forwarding remains inferred. | This does not prove eventual callback execution, object identity, or complete runtime data flow. |
| `csharp.delegate-invocation` / `unknown-runtime-target` | A delegate slot or transfer point is known, but actual runtime handlers are not. | Retain references/passes; handler confirmation needs runtime evidence. |
| `candidate-ownership` | Business ownership or responsibility awaits human review. | Keep this separate from call accuracy; human judgment is needed for business ambiguity. |
| `candidate-explanation` | Explanation text or step grouping awaits review. | Review implementation mappings without automatically confirming them. |
| `source-supported-order` | Valid full-line anchors in one file support narrative position order. | This is not execution proof; retain conditions, loops, early returns, and asynchronous limitations. |
| `unverified-order` | Requests, protocols, narratives, or other associations do not establish execution order. | Partial flows are acceptable; do not invent edges for visual continuity. |
| `source-stale` / `anchor-stale` | Current files or anchors differ from the saved snapshot. | Synchronize the index normally, then review affected explanations. |
| `missing-*` / `invalid-proof` / `invalid-path` | Missing references, dangling edges, or evidence conflicting with a confirmation. | Repair the index/model; do not retain unsupported confirmations. |
| `disconnected-mapping` | An explanation maps to disconnected implementation fragments. | Show their evidence separately; consider splitting or reviewing the grouping. |

Human `confirmed` is an explanation/ownership review status. The report always emits `runtimeVerificationClaimedByAudit: false`; human approval never becomes runtime proof.

## What is checked

- Code nodes, relation endpoints, parents, and evidence references. Nonstructural relations require source evidence.
- Evidence files must belong to the current index, and their hashes must match the indexed files.
- Current authorized files already listed by the index are read to calculate text hashes; evidence line ranges are checked when text is available.
- Model anchor hashes, full-line quotations, and ranges. Changing only a hash cannot conceal a semantic change.
- Underlying relation references for system/module aggregates, business steps, and transitions.
- Implementation nodes, children, evidence, and paths for simple/detail explanations. Call paths require continuous directed real `calls` edges; confidence cannot exceed the underlying facts.
- A `static-confirmed` flow transition requires a real static call between the mapped steps. `source-supported` checks hash-current, valid, nonoverlapping full-line anchors in one file. It requires neither a shared procedure nor proven execution order.
- Project, Worktree, source, model, and semantic projections must agree. Reports record parser/schema, Git HEAD, source, model, definition, and human overlay versions.
- Existing authorized snapshots and derived projections are read through `IndexManager`, `ArchitectureService`, and `SemanticService`. Scanning workers are disabled; the command does not invoke `requestScan`, `watch`, `verify`, or the target program.

The command does not traverse the target to discover new files. Synchronize additions, removals, and changes through normal scanning/watching first. Files are checked individually; the filesystem does not provide a cross-file atomic snapshot. Run when the website shows Synced and source is stable. Index/model changes during the audit prevent a mixed-snapshot report.

## Read a report

`coverage` separates relation kinds/confidence (including `byKindAndConfidence`), ownership and explanation review states, flow verification, source hash coverage, and system/flow summaries. `groups.rules`, `groups.systems`, and `groups.flows` group actionable gaps by cause so candidate explanations are not counted as unknown calls. System counts may overlap because of memberships and must not simply be added to reconstruct global totals.

`totals` retains all findings within the checked scope. `findings` is a bounded sample, retaining errors before warnings and information. `truncation.omittedFindings` states how many details were omitted; grouped samples have their own truncation markers. Reaching the check budget yields `result: incomplete`; unchecked items have not passed. Reaching only the detail budget does not reduce check coverage.

Exit code `0` means no structural errors were found; normal candidates and unverified runtime boundaries can remain. Exit code `1` means `invalid`, `incomplete`, or command failure. Code `0` alone cannot establish human approval of all explanations or verification of every sequence.

## Reproducible regression

```powershell
.\.tools\node-v24.22.0-win-x64\node.exe node_modules/tsx/dist/cli.mjs --test tests/evidence-audit.test.ts
```

Tests distinguish static facts from human review, callback transfer from dynamic targets, and request/protocol/local order. They cover current hashes, full quotations, line ranges, dangling references, cross-scope/model snapshots, invalid paths, check/detail budgets, immutable inputs, and rejection of arbitrary report output paths.
