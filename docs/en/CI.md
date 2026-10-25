# Layered CI

[简体中文](../CI.md) | [English](CI.md)

The workflow is [.github/workflows/ci.yml](../../.github/workflows/ci.yml). Pull requests, pushes to main or codex/public-release, and manual dispatch run a stable `CI gate`, suitable as a required branch-protection check. Use actual Actions results to assess remote execution.

| Layer | Platform | Checks |
| --- | --- | --- |
| changes | Linux | CI selection/gate self-tests, changed paths, locked runtime versions, documentation links, and publication independence |
| fast | Linux | Project-wide TypeScript checking and pure unit/contract tests |
| integration | Windows | Real Python/C# analysis, indexing, filesystem security, HTTP, STDIO, crash recovery, and public export |
| web | Linux | React DOM/navigation, configured-port proxy tests, production Vite build, and artifact upload |
| gate | Linux | Every selected layer must succeed; unselected layers must be explicitly skipped |
| protected-check | Linux | Forward the gate result to the existing required `Tool / typecheck, tests and builds` context, without repeating tests |

The scripts discover `.test.ts` files automatically, assigning each file to one layer. New root test files default to fast and frontend tests to web; explicitly add real-analyzer or native-permission tests to integration. Every product test is included in public snapshots; use each layer's actual `--list` and TAP output for file/test counts. Content-package, story-acceptance, and publication-isolation regressions belong to integration. See [ci-plan.mjs](../../.github/scripts/ci-plan.mjs).

## Change selection

- Frontend changes run fast and web.
- Analyzer, server, MCP, model, configuration, and related test changes run fast and integration. Shared package changes also run web.
- Workflow, dependency lock, runtime, TypeScript, and installation configuration changes run every layer.
- Documentation-only changes avoid heavyweight test runners but still run changes and CI gate.
- Manual dispatch and an unavailable initial baseline run every layer. A failed Git diff or plan fails the gate.

Each test file belongs to one layer, avoiding repeated full-suite runs. The runner creates its own `.cache`, `.tmp`, and results directories. Missing TAP summaries, failures, cancellations, skipped tests, or TODO tests fail CI, so permission-sensitive tests cannot silently disappear.

## Reproducibility and permissions

Node, pnpm, and .NET SDK versions come from `toolchain.lock.json`; the integration layer explicitly uses Python 3.11. Dependencies use pnpm's frozen lockfile and NuGet locked restore. Windows creates a runner-local SDK junction for existing `.tools/dotnet/dotnet.exe` test paths. Persistence regressions require same-directory hard links, loopback, abrupt child-process termination, and directory links; restrictions fail explicitly rather than silently skipping tests.

Actions are pinned to commit SHAs. The token has read-only contents access, checkout does not persist credentials, and the workflow uses neither `pull_request_target` nor repository secrets. A newer run cancels an older run for the same PR/branch. Production web artifacts and integration TAP logs are retained for seven days.

The compatibility check retains the existing protection rule's exact name and succeeds only when `CI gate` succeeds. Failure, cancellation, skipped, or missing gate results fail it. Layering therefore requires no weakening of branch protection.

## Local execution

Complete repository Setup, including the real analyzer build, then run from the root:

```powershell
node --test .github/scripts/ci.test.mjs
node .github/scripts/check-doc-links.mjs
node Tools/export-public.mjs --check
node .github/scripts/ci-tests.mjs fast
node .github/scripts/ci-tests.mjs integration
node .github/scripts/ci-tests.mjs web
```

Append `--list` to a layer command to inspect its allocation. Each layer writes `test-results/ci-<layer>.tap`. A sandbox that restricts loopback connections, directory junctions, or filesystem permissions will explicitly fail integration; rerun with those capabilities available.

CI does not publish a site/package, modify a real target project, or establish runtime semantics. Remote Actions execution, external vulnerability databases, and a cross-platform installer still require separate validation.
