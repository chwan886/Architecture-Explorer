# Project content adapters

[简体中文](../CONTENT-PACKS.md) | [English](CONTENT-PACKS.md)

The tool has no default business project, fixed domain symbols, or mandatory private content. Configuration authorizes source, responsibility models define flows, content packages customize explanations, and acceptance stories specify facts to check. Packages and stories are explicitly loaded JSON, without executable plugins or imports of target modules.

## Generic semantic seeds

Maintain responsibilities and flows in `architecture/models/<projectId>/model.json`, then run a normal Scan. Preview initial explanations:

```powershell
pnpm seed-semantics --config config/my-project.local.json --project my-project --dry-run
# After inspection, remove --dry-run to create a missing definitions.json.
```

`--project` is required. Configuration may instead come from `EXPLORER_CONFIG` or the default local configuration. `--worktree` defaults to `primary`; other values must identify an authorized Worktree. Missing models or flows return an empty result (`no-model` / `no-flows`) without requiring an index or creating output. Existing flows use the scope's saved index; Scan again if its version, configuration, or source is missing or stale.

Any authored flow can generate candidates, without predefined IDs or counts. Explicit bindings require one exact method/function selector and a current declaration hash. Narrative steps without selectors remain unbound candidates, without guessed implementations. Default prose comes from the model; no control-flow or cross-language relationships are inferred automatically.

Creation uses the shared file lock, a complete temporary file, and atomic publication. Existing definitions, human overrides, and reviews are never overwritten. Dry runs validate the same inputs and print a summary without writing definitions. Output is restricted to the tool directory, outside every analysis target.

## Optional external packages

```powershell
# The included demo already has definitions, so preview without overwriting.
pnpm seed-semantics --config config/demo.json --project combat-demo --content-pack examples/content-packs/combat-description --dry-run
```

`--content-pack` explicitly authorizes a directory. Only its fixed `content-pack.json` is read, bounded to 512 KiB with strict UTF-8 and an [independent schema](../../packages/semantic-content/content-pack.schema.json). No argument means no package-directory discovery. Linked package files, extra properties, unknown flows/steps, control anchors outside the current step, and invalid partitions are rejected.

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Currently `1.0.0` |
| `projectId` | Optional; when present, must match the authorized project |
| `flows[].sourceFlowId` | An actual flow ID from the current responsibility model |
| `steps[].sourceStepId` / `text` | Customize existing titles, descriptions, inputs, outputs, and other prose |
| `steps[].controls` | Candidate conditions, loops, async boundaries, early returns, or request boundaries; anchors must belong to the current step's valid local anchors |
| `groups[].stepIds` / `text` | Summary groups that cover every detail step exactly once |

Packages cannot supply source paths, quotations, symbol selectors, new code relations, runtime proof, or human reviews. Generated nodes are `rule-generated`, awaiting review. The [runnable demo package](../../examples/content-packs/combat-description/content-pack.json) uses only the independently authored example. Keep private packages outside Git or in excluded locations.

## Configured evidence acceptance

```powershell
pnpm validate-story --config config/demo.json --story Tools/stories/combat-demo.json
```

The [example story](../../Tools/stories/combat-demo.json) declares node selectors, expected relations, and local graph requirements. The [generic command](../../Tools/validate-story.ts) requires `--config` and `--story`. Choose a project through `--project` or the story's `projectId`; it never selects the first project implicitly. `--worktree` can override selection but must remain authorized and agree with the story. The old `Tools/validate-hp.ts` only forwards these arguments and has no built-in story.

- Node selectors must match exactly one current indexed entity. Missing or ambiguous matches fail.
- Relations specify `kind`, `confidence`, and `minCount`. Only `static-confirmed` is accepted by default; accepting `inferred` requires explicit JSON configuration.
- Every matched relation's current evidence, complete metadata, source, and final index version must agree. Local graphs can also require `requiredKinds`; display truncation cannot silently satisfy missing requirements.
- The command normally scans the authorized target, then verifies facts and the cache. It never builds or executes the target. Reports are published atomically to fixed tool-cache filenames, without arbitrary output-path arguments.

Unsatisfied structure, evidence, or version requirements return exit code 1; passing returns 0. Passing only establishes the configured static facts, without proving runtime order, dynamic targets, or cross-language value transfer.

## Regression and publication

Package and story tests use synthetic targets, covering no-package use, empty models, multiple projects, Worktree isolation, stale/ambiguous evidence, invalid paths, and target read-only boundaries. Public copies retain every product test. The complete suite runs independently without external private models, configuration, or caches; see [publication privacy](PUBLICATION.md).
