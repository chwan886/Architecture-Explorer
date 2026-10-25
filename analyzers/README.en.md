# Source analysis workers

[简体中文](README.md) | [English](README.en.md)

Both workers parse source strings supplied in requests. They do not import, execute, or build the target project. C# additionally reads explicitly configured assembly metadata, without executing assemblies or running MSBuild targets.

Input/output follows the [implementation contract](../docs/en/CONTRACT.md) and `packages/schema/src/index.ts`. Default mode accepts one complete JSON request and returns one result. `--persistent`, also available as `--server`, uses line-delimited JSON and exits on EOF. Standard output contains protocol JSON only; diagnostics are part of the result. Process-level error types go only to stderr. All JSON pipes use UTF-8. Evidence columns are one-based UTF-16 positions.

## C#

- Project: `analyzers/csharp/ArchitectureExplorer.Analyzers.csproj`, targeting .NET 10.
- Roslyn is pinned to `Microsoft.CodeAnalysis.CSharp 4.14.0`; the NuGet lockfile is checked in.
- Entry artifact: `analyzers/csharp/bin/Release/net10.0/ArchitectureExplorer.Analyzers.dll`.
- Supports declarations, partial type merging, overloads, inheritance/interface implementation, type references, statically bound calls, constructors, explicit field/property reads and writes, declaration initializers, event publishing/subscription syntax, and explicit handler references.
- Lambdas and local functions have separate scopes. Lambda identities combine the containing symbol with an ordinal in that scope, without line numbers. Inserting a lambda earlier in one method can change later anonymous identities. Parameters belonging to distinct lambdas with the same signature are not merged.
- Virtual-call edges identify the compiler-bound declaration target. `dispatch=virtual-declaration` states that the actual override is unknown.
- `ref`/`out` produce inferred potential writes only. Arbitrary property getter/setter side effects, collection-element mutation, reflection, dynamic calls, final delegate targets, and Unity lifecycle timing are not fully modeled.
- `nameof` creates a reference rather than a data read. Compound assignments create both read and write edges.
- Missing references retain declarations and produce compilation-context diagnostics. Missing Unity or other types do not generate invented implementations; call targets are not guessed by name.
- Actual syntax errors return `CS_SYNTAX_*` with `severity=error`; semantic-context issues such as missing references return warnings. On errors, the indexer retains the last valid index so partially edited syntax cannot replace a complete map.
- Without an explicit core library, the worker uses trusted runtime metadata from its host. If configuration includes `mscorlib.dll` or `System.Private.CoreLib.dll`, only the explicit reference set is used. The analysis context is not equivalent to Unity's actual per-asmdef build configuration; merged analysis cannot validate assembly accessibility boundaries or the real game build.

## Python

- Entry point: `python -B analyzers/python/analyze.py`.
- Uses the standard-library `ast` and `symtable` parsers for syntax/scopes, without third-party packages.
- Supports functions, classes, parameters, lexical containment, imports, and conservative direct-function binding. Unresolved instance methods, dynamic bindings, and rebound targets produce aggregated diagnostics.
- Import roots depend on `sys.path`. Calls through imports matching other input files are marked inferred, without claiming runtime import verification.
- Decorators can replace functions, so affected calls are downgraded to inferred. Function names shadowed by parameters, redefinitions, or local assignments do not receive confirmed call edges.
- Dictionary/property access nodes are separated by **function and root expression**. Keys named `hp` in different functions do not automatically share identity. These are inspectable static access locations, without claims about cross-function object aliases or complete runtime data flow.
- The analyzer does not infer a unified type identity for Python instance attributes, execute decorators, or resolve monkey patches/arbitrary callback targets.

## Incremental behavior

Persistent processes reuse ASTs/SyntaxTrees by scope, relative path, hash, and source content. C# define changes invalidate parsing caches; reference metadata length/timestamp changes invalidate the semantic context.

Deleting a file removes its tree and corresponding results. C# removes/adds changed trees in an immutable `Compilation`. To avoid missing cross-file binding changes, the initial implementation conservatively regenerates semantic relationships for the language context.

Unchanged sources are therefore not reparsed every time, but semantic rebinding still covers the merged context; this is not complete symbol-level incremental analysis. Every result includes an `info` diagnostic named `incremental-parser` with `parsed=N; reused=N; removed=N`.

## Validation

Run the root tool bootstrap/build first, then execute from the repository root:

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/analyzers.test.ts
```

Golden cases cover overloads, partial types, compound field reads/writes, conditions, events, lambdas/local functions, missing Unity references, Chinese/emoji evidence, Python rebinding/scoped keys, syntax failures, and parse reuse after edits/deletions in one process.

Real-project statistics and end-to-end acceptance are recorded in the coordinating documentation. This README does not claim runtime verification.
