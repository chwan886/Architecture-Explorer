# Implementation repair record

[简体中文](../REPAIRS.md) | [English](REPAIRS.md)

Date: 2026-10-25 (America/Toronto). This record follows F01–F11 in the [initial review](OPEN-SOURCE-REVIEW.md). Each fix began with a regression reproducing the previous behavior, followed by implementation changes and validation of code, tests, and publication export. No real analyzed project was modified or executed.

## Repairs

| ID | Change | Regression evidence |
| --- | --- | --- |
| F01 | Model persistence checks actual serialized UTF-8 bytes against the 1 MiB read budget. Oversized saves return 413 and preserve the readable model. Writes overlapping any authorized target are also refused. | [architecture-api.test.ts](../../tests/architecture-api.test.ts): the old implementation accepted a request below 512 KiB that expanded beyond 1 MiB. The repair rejects it, round-trips valid multibyte models, and preserves read-only targets. |
| F02 | Runtime publication, architecture models, semantic overlays, and scans share a [file-lock protocol](../../packages/indexer/src/file-lock.ts). A complete process record is written before atomic hard-link publication. Recovery is serialized per ownership generation and requires proof that the local PID exited. | [persistence-lock.test.ts](../../tests/persistence-lock.test.ts): 18 cases cover abrupt termination at four real entry points, one critical-section entrant among 16 contenders, live/unknown/foreign/corrupt/EPERM owners, legacy records, and reclaimer crashes. Independent review reproduced an equivalent-path guard bypass; canonical guard keys and resolved directories now pass case and `/./` aliases. |
| F03 | C# local functions use their semantic owner and same-signature declaration ordinal to distinguish sibling/nested declarations without line numbers. | [csharp-bindings.test.ts](../../tests/csharp-bindings.test.ts): separate branches retain separate calls; ordinary lines and unrelated local declarations do not change identities. |
| F04 | C# edge identities include dispatch and confidence. Repeated equivalent calls still aggregate evidence; differing dispatch or certainty remains separate. | Real analyzer tests cover reordered `base.V()`/virtual calls and definite assignment versus inferred ref writes. All three new C# cases failed before the repairs and pass afterward. |
| F05 | Python resolves and visits bases/keywords before entering class scope. Base factories, metaclasses, and decorators are evaluated in the enclosing scope. | [python-resolution.test.ts](../../tests/python-resolution.test.ts): same-named class members cannot become their own base; factory-returned base identity remains unknown. |
| F06 | Python class-local imports are not method/lambda closures. Module imports, enclosing function imports, and class-body imports retain their proper scopes. | Positive and negative cases cover aliases, rebinding, and class-local callables; false targets are no longer emitted. |
| F07 | Python stores ASTs, definitions, and binding counts by file. Module names retain multiple candidates, conflicting declarations gain file identity, and `PY_AMBIGUOUS_MODULE` reports ambiguity. | Both `pkg.py` and `pkg/__init__.py` retain their calls/accesses. Reordering, removal, and restoration through persistent caches are repeatable, and ambiguous imports choose no target. |
| F08 | Projection, audit, and CLI acceptance share the [source-position predicate](../../packages/architecture-model/src/source-order.ts). Valid endpoint anchors in one current file support narration only. | [evidence-audit.test.ts](../../tests/evidence-audit.test.ts): missing procedure selectors and cross-procedure position narration no longer cause false errors; stale, missing, reversed, cross-file, invalid-range, and forged quotations remain rejected. Protocol/request/runtime ordering is not upgraded. |
| F09 | Editor GET/PUT responses include complete metadata. Drafts own their viewRevision and overlayRevision, and reloads/repeated saves refresh both without relying on SSE. | [SemanticWorkspace.test.ts](../../apps/web/src/semantics/SemanticWorkspace.test.ts) and [semantic-api.test.ts](../../tests/semantic-api.test.ts): the old stale-view reload failed; no-SSE recovery and consecutive saves now pass. Old drafts lacking a complete baseline remain available for export but cannot be blindly saved. |
| F10 | External detailed locations expand the matching semantic/reverse-mapped groups or edge endpoints and focus their canvases. Explicit targets clear old filters that would hide them. | Component tests and [real App navigation](../../tests/semantic-app-navigation.test.ts) assert actual target detail visibility. A remembered-filter counterexample also failed first and passes after repair. |
| F11 | Vite reads and validates the selected configuration's port without inspecting target roots. Builds require no valid project configuration. | [vite-config.test.ts](../../tests/vite-config.test.ts): a real temporary API and Vite proxy use a nondefault port, with BOM, default, and invalid-value coverage. |

## Lock boundaries

Locks do not expire by age. Live PIDs, denied probes, foreign hosts, and unparseable records fail closed. Legacy `pid:UUID` locks can recover after confirmed process exit. Ownerless legacy runtime tokens cannot establish ownership and still need manual inspection after all related processes stop. PID reuse conservatively prevents recovery rather than stealing from the new process.

The protocol requires same-directory hard-link support. Recursive recovery and contention have finite budgets and fail explicitly when exceeded. Sudden power loss, remote shared filesystems, and malicious external lock modification were not validated in this work.

## Cache compatibility

The analyzer version increases from `0.2.0` to `0.2.1`. Normal scans recompute context and facts. Some local-function, relationship, and conflicting-module IDs change; reacquire old browser/MCP snapshots. The declaration-hash algorithm is unchanged, so unchanged declarations need no bulk baseline update.

Inserting/removing an earlier local function with the same signature changes later ordinals. Python ambiguity-set changes may also affect identities; versions and fingerprints invalidate impacted references. Old lastgood indexes and historical audit results do not upgrade automatically: Scan before Audit.

## Publication results

- Generic semantic-content tests now use an independent in-memory fixture. All 11 passed in a directory without private models or preexisting caches.
- Anonymous snapshot export and privacy regressions exclude original author history, remotes, private models, runtime directories, nonexample configurations, and `.env` files. Subsequent decoupling adds optional JSON packages, generic seeds, and configured acceptance stories; the [publication audit](PUBLICATION.md) records implementation and isolation regressions.
- Added the original [PolyForm Noncommercial 1.0.0](../../LICENSE), [NOTICE](../../NOTICE), and [bilingual licensing explanation](LICENSING.md). This is source-available with permitted noncommercial use free and commercial permissions agreed separately in writing.
- CI discovers new tests, assigning real lock/export/package/story tests to integration and custom-port tests to web. Former private-content checks are now self-contained demo regressions. Every product test is published; no test files are excluded.
- Remote GitHub Actions, vulnerability databases, third-party license inventory, large-graph benchmarks, and complete browser validation remain separate work. Local success does not replace those checks.

## Initial repair verification record

The original working tree passed fast **46/46**, integration **150/150**, and web **83/83**: **279/279** in total, with zero failures or skips. CI/documentation-checker self-tests passed **7/7**. TypeScript, the Roslyn Release build, and the production Vite build passed. Native cases ran with hard links, directory links, loopback, and abrupt child-process termination available.

These counts describe the initial Windows verification of F01–F11, rather than the subsequent decoupled revision, GitHub's Linux runners, or a clean online installation. New regressions cover packages, acceptance stories, and privacy checks; demo checks replace private-content tests. Use the complete layered TAP output for current counts. Existing Vite directive/ELK chunk notices remain visible.

## Project independence regressions

[semantic-seed.test.ts](../../tests/semantic-seed.test.ts) covers two independent projects, empty models, external packages, Worktree/version isolation, linked-file rejection, atomic concurrent import, and protection of human content. [story-acceptance.test.ts](../../tests/story-acceptance.test.ts) uses synthetic Python targets that are never executed, covering configuration selection, ambiguity, complete current evidence metadata, static-confidence boundaries, and the compatibility command.

Former private model/flow tests now validate the [demo model](../../tests/demo-architecture.test.ts) and [demo semantics](../../tests/demo-semantic-flows.test.ts), without external models or definitions. [Publication regressions](../../tests/public-export.test.ts) retain generic implementations and tests while rejecting private project identifiers, long quotations, and original Git identities. See [project content adapters](CONTENT-PACKS.md) for runnable commands.

Remote Windows CI also exposed account-alias handling missing from this baseline. Native SDDL parsing now expands `LA` to a full SID before allowing only the current user and SYSTEM; administrator groups and other users remain rejected. [Permission regressions](../../tests/bridge-permissions.test.ts) cover real Windows parsing, explicit third-party access, rejected publication, and absence of credential leftovers. Fixtures initialize only newly created, boundary-checked temporary directories, without resetting existing ACLs. A compatibility summary check retains the existing branch-protection requirement.
