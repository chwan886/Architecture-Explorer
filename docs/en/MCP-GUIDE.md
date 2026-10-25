# Local Codex MCP integration

[中文](../MCP-GUIDE.md) | English

The integration provides read-only architecture queries and website presentation control. It includes no website chat, model API, Shell tool, or target writes. MCP reuses the existing index, system model, and semantic projections for explicitly authorized project configurations.

## Start and connect

From the tool directory:

```powershell
.\Tools\explorer.ps1 -Task Dev
```

The website listens only on `127.0.0.1`. Open the configured port, [4310 by default](http://127.0.0.1:4310), and click Allow Codex control. Pages without permission reject remote navigation. A separate MCP HTTP service is unnecessary.

Start the stdio service as follows. Waiting for input is normal; stdout is reserved for MCP JSON-RPC:

```powershell
.\Tools\explorer.ps1 -Task Mcp
# Or select an authorized tool configuration.
.\Tools\explorer.ps1 -Task Mcp -Config .\config\local.json
```

Configure local STDIO in Codex App Settings → MCP servers → Add server, or review and append the block in `config/codex-mcp.example.toml` to the user-level `~/.codex/config.toml`. App and CLI use the official MCP configuration mechanism. If the block already exists, review and merge it instead of appending a duplicate. The implementation never changes user configuration. Replace `<repo>` in examples with your actual tool installation directory; for a development Worktree, use its absolute path and matching configuration. Port and cache must agree.

See the official [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). After saving, follow the App's MCP server restart prompt, then enter `/mcp` to inspect the connection. If the current turn has not refreshed tool discovery, continue on a subsequent turn after reloading. `codex mcp list` only establishes that configuration exists. Verify real calls to `get_capabilities` and `list_projects`, then complete the workflow below.

## Recommended call sequence

1. Call `list_projects` and `list_worktrees`; select only authorized targets.
2. Call `begin_analysis` to pin an analysis snapshot. Retain all returned IDs and revisions.
3. Use `search_architecture` for symbols, Chinese module names, or semantic titles. Verify facts with `get_node_details`, `get_related_graph`, and `get_source_evidence`.
4. Use `get_flow` to list/read existing flows. `get_call_paths` only returns real directed call paths. A BFS neighborhood, dependency, or unverified transition is not execution order.
5. Call `list_view_sessions`, choose a specific permitted page, then `attach_view_session`. Multiple tabs have no implicit current page. Resolve ambiguity explicitly. Retain `bindingId`, `userRevision`, and `controlRevision`.
6. Submit `show_flow`, `open_architecture`, or `present_analysis`. Online control requires the binding and both revisions.
7. Poll `get_presentation_status(commandId)` until `presented`, then inspect the actual snapshot, entities, and evidence. `pending` and `received` do not establish successful presentation. Layout or snapshot failures report a reason.
8. `set_view_mode`, `highlight_nodes`, and `focus_node` require a `basePresentationId` submitted in this MCP session and explicit current confirmed revisions. Flow, focus, and snapshot persist. Never refresh revisions and automatically retry over a human action after a conflict.

Query tools: `get_capabilities`, `list_projects`, `list_worktrees`, `begin_analysis`, `search_architecture`, `get_node_details`, `get_related_graph`, `get_call_paths`, `get_flow`, `get_source_evidence`, and `semantic_reverse`.

Control tools: `list_view_sessions`, `attach_view_session`, `open_architecture`, `show_flow`, `present_analysis`, `highlight_nodes`, `focus_node`, `set_view_mode`, `clear_highlights`, and `get_presentation_status`. Each has strict JSON Schema, Chinese descriptions, and argument budgets.

Clearing highlights preserves the human browsing context. Restore manual browsing/Leave control revokes the binding. Old MCP commands cannot re-enable it. When the website is closed, the service can retain the latest valid request and return a fixed loopback `openUrl`. After opening the page, granting permission, and explicitly binding, the request is revalidated before delivery. Restarted services never guess a new index for an old snapshot handle; expired requests require fresh queries and submissions.

## Presentation protocol and evidence

`packages/control-protocol/src/types.ts` defines `AnalysisPresentation`: version; presentation/project/Worktree/indexSnapshot/snapshot IDs; title and summary; target page; three modes and two granularities; layer-specific focus/highlights; flowId; orderedSteps; evidenceIds; warnings; and createdAt.

- `code` IDs come from the raw index, `architecture` IDs from the current projection, and `semantic` references require `flowId`. Do not invent IDs.
- `orderedSteps` supports one-to-many code mappings and records inputs, outputs, evidence, code edges, server-registered pathId, verification, and orderBasis.
- `evidenceIds` is the proof collection for the analysis, not a fixed first-item preview. With a focus, the preview prefers evidence belonging to that node or outgoing code relations. Changing focus selects corresponding source while retaining the full proof collection. Nodes without their own evidence do not inherit unrelated old source.
- `reading-order` is explanatory reading order. `call-path` requires a registered path from this snapshot and is still not complete runtime order. Unsupported steps are `unverified`.
- Missing, cross-Worktree, hidden/unpresentable, over-budget, or expired references fail explicitly rather than being ignored.
- Search previews up to 12 evidence IDs per hit, with `evidenceCount` and `evidenceTruncated`. Obtain additional system-member evidence through details. Explicit path displays retain requested endpoints and actual edges. Without explicit edges, neighborhoods default to 16 nodes; explicit requests still have an 80-node hard budget.
- Snapshot handles last 10 minutes, with at most 16 retained. Source, model, human semantic edits, or authorization changes invalidate them; call `begin_analysis` again.
- Start after the index is Synced. Republishing an index object also invalidates handles even when the content revision is unchanged. Expiry clears old highlights and requires a new analysis instead of replacing results silently.
- Data neighborhoods are static reads/writes. Dynamic dispatch/callbacks and cross-HTTP relations are not confirmed automatically. Missing connections are not invented.

Semantic flows come from the current project's models and optional content packages, without fixed flow IDs or domains. Always use `get_flow` to discover the flows present in the current snapshot. The included demo provides a calculation and state-application flow. Preserve gaps for dynamic callbacks, separate requests, and cross-language fragments rather than claiming a complete execution chain.

## Ready-to-use prompts

> Use Architecture Explorer MCP to inspect the included demo's business flows. List projects and Worktrees, pin a snapshot, search, and check source evidence. Distinguish confirmed calls, candidate business explanations, and unverified order. Choose the page I have allowed for control and show a flow present in the current snapshot as a simple business explanation. Wait for a presented receipt, then explain the result and remaining gaps.

> In the same snapshot and flow, expand detailed explanations, then switch to Compare. Preserve the focus and highlight all implementations mapped to that step. If human interaction or an index change causes a conflict, stop the old presentation and explain why.

> Query real call paths from the current flow's entry point to its calculation method, inspect evidence, and present them in the code graph. Explain dynamic callbacks, missing edges, and ordinary dependencies separately. Do not join disconnected fragments into a verified execution chain.

> Query static reads and writes for this health field, and show related methods and source. Explain that this is the current parser's supported access scope, not complete runtime data flow.

## Security and troubleshooting

| Situation | Action |
| --- | --- |
| SERVICE_NOT_RUNNING / SERVICE_UNREACHABLE | Start the website and ensure MCP and website share configuration, port, and cache. |
| SERVICE_IDENTITY / UNSAFE_RUNTIME | No token is sent. Inspect cache permissions, links, or port conflicts. Do not copy tokens from the website. |
| RUNTIME_IN_USE / RUNTIME_LOCKED | A live instance or publication lock already owns this cache. Same-host locks with an explicitly dead PID can recover automatically. Live, unknown, and malformed owners fail closed. Inspect processes/logs; handle unrecognized legacy locks manually only after confirming all related instances have stopped. |
| STALE_SNAPSHOT / SOURCE_CHANGED | Repeat begin_analysis, search, and evidence checks. Do not force old analysis through by replacing IDs. |
| AMBIGUOUS_SESSION / SESSION_NOT_ALLOWED | Grant permission on the intended page, list sessions, and attach that document explicitly. |
| Revision conflict / manual browsing | Stop old control requests and preserve human actions. Rebind/resubmit only after confirming the new intent. |
| pending / received | Inspect the page's control indicator, SSE/network, and receipt. Receipt is not presentation; avoid unlimited retries. |
| PRESENTATION_TOO_LARGE | Reduce node/path scope and present in steps. A code presentation has at most 80 nodes. |
| Tools absent from the current Codex chat | Reload in MCP settings and inspect `/mcp` or `/mcp verbose`; continue on a later turn if needed. Configuration and actual model tool calls are separate checks. |

The service uses Host/Origin checks, JSON/CSRF, and HttpOnly SameSite=Strict browser identity. Private requests use a tool-cache token readable only by the current user and SYSTEM. The sidecar verifies service identity with random nonce/HMAC before sending authenticated requests to its fixed `127.0.0.1` port. It does not follow redirects. SSE carries notifications; the frontend pulls state and performs a final revision check. Tokens, browser CSRF values, and caches are excluded from Git and Codex configuration.

Binding leases last 120 seconds; pages expire after 90 seconds without a heartbeat; pending presentations last at most 5 minutes. Rebind explicitly after expiry. Full reloads or service restarts establish a fresh page session and require permission again. Layout, reading history, and human focus persist within the current document; a reload cannot pretend the old binding survived. `actual.visibleNodeIds` describes entities in the current canvas level and budget, not simultaneous pixel visibility. Explicit focus is handled separately through canvas positioning.

The website's [movable presentation bubble](PROGRESS-BUBBLE.md) shows public explanation summaries, actual query activity, and presentation/pause state. It can be dragged, collapsed, hidden, and restored. Explanations reuse `present_analysis` title, summary, and orderedSteps without new MCP tools, AI APIs, or user configuration. Query activity appears only after the current snapshot is presented and bound to one page. Query completion and website presentation are separate events.

## Verification commands and scope

```powershell
.\Tools\explorer.ps1 -Task Typecheck
.\Tools\explorer.ps1 -Task Test
.\Tools\explorer.ps1 -Task Build
```

Tests cover strict arguments, snapshots/evidence, a real SDK stdio client, authenticated service, sessions, and receipts. Protocol tests simulate browser ACKs and are not visual acceptance. Real-browser and Codex App tool-call acceptance are recorded separately in [MCP validation](MCP-VALIDATION.md). Any part without real App discovery/calls must remain unverified.
