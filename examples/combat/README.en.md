# Combat demo

[简体中文](README.md) | [English](README.en.md)

This small example supports first-time exploration and the README screenshots. All source is included in this repository; no game checkout, Unity installation, or external project is required.

- Four C# files show turn orchestration → damage rules → actor state, plus a HUD reading Health.
- Two Python files show an imported call and function-local dictionary reads and writes.
- The languages are independent examples. There is no HTTP/JSON transport and no established cross-language Health/hp data flow.
- Analyzers read these files without executing them. Responsibility and explanation models remain candidates with no human confirmations.

After Setup and Build from the root README, run from the repository root:

```powershell
./Tools/explorer.ps1 -Task Dev -Config ./config/demo.json
```

The [configuration](../../config/demo.json), [architecture model](../../architecture/models/combat-demo/model.json), and [semantic definitions](../../architecture/semantics/combat-demo/definitions.json) are included.

Open localhost port 4310. Drill from the system overview into modules and components, switch the business flow to two-layer comparison, or search for Health, open its data-access graph, and select the Actor.cs line 10 write evidence.

Source anchors and semantic declaration hashes bind to this exact example version. After editing source, rescan and update anchors or revalidate bindings rather than reusing stale hashes. Screenshots show this example at 1280×720, using only the included synthetic content.
