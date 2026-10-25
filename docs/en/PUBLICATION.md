# Publication privacy and project dependency audit

[简体中文](../PUBLICATION.md) | [English](PUBLICATION.md)

Publication policy: **do not publish analyzed project source or quotations. Screenshots are the maintainer's allowed exception.** Installation, execution, tests, and the demo require no external private checkout, models, or caches.

## Author and historical information

Development worktrees share the original Git database. Publication uses an independent anonymous snapshot, keeping the original repository for local recovery:

```powershell
node Tools/export-public.mjs --check
node Tools/export-public.mjs --export
```

Run from the repository root. The exporter creates an independent repository under ignored `.release/`, including current working files and uncommitted repairs, with one anonymous root commit:

- Both author and committer are `Architecture Explorer contributors <contributors@example.invalid>`, without personal email.
- Original `.git`, ancestors, branches, tags, notes, reflogs, remotes, signatures, configuration, and runtime caches are not copied.
- Export isolates inherited Git identity/configuration and disables hooks and signing. The new copy's local author configuration is anonymous too.
- Push an explicit branch from the new copy, without the original repository's old refs. If an existing remote contains old history, a new anonymous branch does not hide its original `main`, tags, or other refs. Replacing those refs is a separate history rewrite requiring explicit authorization.

Export neither pushes nor creates a remote. It checks public dependencies, documentation links, linked paths, and privacy information before writing, and fails closed on errors. Local export cannot retract history from remote caches, third-party clones, or mirrors.

## Project adapters are decoupled

| Area | Current implementation | Regression and publication policy |
| --- | --- | --- |
| Server, browser, MCP, and indexer | Projects, roots, and Worktrees come only from authorized configuration, without a fixed project ID, class name, or flow | Synthetic temporary targets, empty models, multiple projects/Worktrees, and independent demo scanning/auditing |
| Base models and semantic definitions | `architecture/{models,semantics}/<projectId>/` is optional content; missing files produce an empty business model | Only the independently authored `combat-demo` is published. Other project directories, including their readmes, are not copied |
| Semantic seed chain | Generates conservative candidates from any flows in the current model. External content packages require an explicit argument and contain only JSON; no executable plugins or private-directory discovery | `tests/semantic-seed.test.ts` covers no-package use, custom projects, validation, and CLI behavior. All generic seed code is published |
| Story/evidence acceptance | `Tools/validate-story.ts` uses JSON to declare symbol selectors, relations, and graph expectations, without built-in domain symbols. The old entry point is only a compatibility wrapper | `tests/story-acceptance.test.ts` uses synthetic source; a self-contained acceptance example is included |
| Demo content acceptance | Former target-specific tests now use the self-contained demo and synthetic boundary fixtures | `tests/demo-architecture.test.ts` and `tests/demo-semantic-flows.test.ts` are included in the full public suite; product tests are no longer excluded |
| Generic editing and candidate generation | Independent in-memory fixtures; no private model reads at module initialization | `tests/semantic-content.test.ts` retains editing, grouping, generation, and storage coverage |
| Old content and historical material | Originals exist only for local recovery and cannot supply product functionality | Private models are omitted; historical documentation receives neutral bilingual stubs that preserve links |
| Screenshots | Current README images show only the self-contained demo | No external private target source |

See [project content adapters](CONTENT-PACKS.md) for formats, commands, and safety boundaries. Optional content remains a candidate explanation; it cannot upgrade static evidence or forge human confirmation. Store private packages and local configuration outside Git or in excluded locations.

## Publication verification

1. Run every CI layer, type checks, and analyzer/website builds. Product tests require no private directories and are not excluded during publication.
2. Preflight and export. In the new copy, independently verify documentation, the complete suite, builds, demo scanning, and evidence auditing.
3. Inspect anonymous author/committer, a single root commit, clean status, and an explicit push destination. Do not use `--mirror` or push all refs.
4. CI runs publication preflight before selecting test layers. Third-party dependencies retain their licenses. See [licensing](LICENSING.md) for project terms.

Independence means the product and its regression suite do not require private project content. Publication checks are not a general secret detector for arbitrary new content; review the publication scope of new configuration, documents, and screenshots.
