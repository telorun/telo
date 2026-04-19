# Diagnostics Everywhere

## Goal

Surface analyzer diagnostics in every UI site where a resource name, module name, or import alias is rendered. Replace the current hover-only HTML `title` tooltip with a click-to-open popover that shows the full message in a selectable, copyable form and offers a "jump to source" action.

## Non-goals

- **No deep aggregation across module boundaries.** `Kernel.Import` rows in the sidebar do not show diagnostics from the imported module. They only show diagnostics that target the import resource itself (which already live in the parent module's `diagnosticsByResource`).
- **No new diagnostic source.** Everything still comes from `analyzeWorkspace` in [analysis.ts](apps/telo-editor/src/analysis.ts). No new analyzer passes, no runtime-error plumbing.
- **No notification center / problem panel.** A single Inventory-style full list already exists; adding a global "Problems" panel is a separate idea.
- **No severity filter UI.** Badges show the worst severity and a count — filtering/muting is out of scope.

## Principles

1. **One badge primitive.** A single `DiagnosticBadge` component renders in every site. All variation (size, density, whether to show the count, how to anchor the popover) is driven by props, not by duplicated components.
2. **Aggregation is a pure function.** All rollup logic (module-level, definition-level) lives in one helper next to `view-data.ts`. Callers pass in keys; helper returns `{ worstSeverity, count, diagnostics[] }` or `null`. No component reaches into `diagnosticsByResource` shape directly.
3. **Popover over tooltip.** Use the existing Radix `Popover` ([ui/Popover.tsx](apps/telo-editor/src/components/ui/Popover.tsx)). Hover tooltips fight with text selection; click-to-open gives us copy UX for free.
4. **Navigation is a single callback.** `navigateToDiagnostic(filePath, range?)` is passed into the badge. The Editor owns the implementation; every site reuses it.

## Data model

### Fix analyzer → state: stop dropping unscoped diagnostics

[analysis.ts:141-154](apps/telo-editor/src/analysis.ts#L141-L154) currently skips any diagnostic without `data.resource.kind+name` AND any diagnostic whose kind/name doesn't resolve to a known manifest. Real diagnostics are silently dropped — notably the ones from [analyzer.ts:335](analyzer/nodejs/src/analyzer.ts#L335) that fire when a manifest is missing `kind` or `metadata.name` entirely (i.e. the worst-case manifest never surfaces anywhere in the UI).

Fix: `analyzeWorkspace` returns a new shape that carries both resource-scoped and file-scoped diagnostics.

```ts
export interface WorkspaceDiagnostics {
  byResource: Map<string, Map<string, AnalysisDiagnostic[]>>;  // filePath → name → []
  byFile: Map<string, AnalysisDiagnostic[]>;                   // filePath → diagnostics NOT tied to a named resource
}
```

Routing rules inside `analyzeWorkspace`:
1. If `data.resource.kind+name` resolves via `sourceByManifest` → append to `byResource[filePath][name]` (today's behavior).
2. Else if `data.filePath` is present → append to `byFile[filePath]`.
3. Else → append to `byFile[UNKNOWN_FILE_KEY]` (a documented sentinel). These are analyzer-internal issues that aren't tied to any file we can identify; the Problems panel hedge (below) will show them. Dropping them silently, as today, is the bug this plan fixes.

Enabling route (2): add `filePath` to every `data: { … }` payload in [analyzer.ts:335,363,395,430,488](analyzer/nodejs/src/analyzer.ts#L335). The source filePath is already on each manifest's `metadata.source` at the call sites — this is an additive stamp: `data: { …existing, filePath: m.metadata.source }`. `data` is typed `unknown` and the VS Code extension (the only other known consumer) reads `data.resource` but ignores other keys, so adding a new field is a no-op for downstream consumers. Commit to this route — do not build a `fallbackFileByManifestIndex` reverse map in `analysis.ts`; the analyzer is the natural place to know the file.

`EditorState.diagnosticsByResource: Map<filePath, Map<name, []>>` is replaced by `EditorState.diagnostics: WorkspaceDiagnostics`. Callers of the old field are rewritten.

### New: aggregation helper

New file: `apps/telo-editor/src/diagnostics-aggregate.ts`

Per-diagnostic provenance is required: a module rollup spans owner + partials, and "Open in source" must know which tab to activate. The summary carries filePath alongside each entry.

```ts
export interface LocatedDiagnostic {
  filePath: string;
  diagnostic: AnalysisDiagnostic;
}

export interface DiagnosticsSummary {
  worstSeverity: DiagnosticSeverity;       // 1 (Error) is worst
  count: number;
  diagnostics: LocatedDiagnostic[];        // ordered by severity then message
}

// A diagnostic with no explicit severity defaults to Error (the worst). This
// keeps unknowns visually dominant — better to over-warn than to demote real
// problems to info-level silence.
const DEFAULT_SEVERITY = DiagnosticSeverity.Error;

// Resource-scoped summary. Scans every known file for a matching resource
// name — needed because resources defined in partials are keyed by the
// partial's path, not the owner's.
export function summarizeResource(
  state: Pick<EditorState, "diagnostics">,
  filePaths: string[],          // owner + partials the module spans
  resourceName: string,
): DiagnosticsSummary | null;

// Module rollup (owner + partials). For each filePath in the list, includes
// every entry in byResource[filePath][*] and byFile[filePath].
export function summarizeFiles(
  state: Pick<EditorState, "diagnostics">,
  filePaths: string[],
): DiagnosticsSummary | null;

// Forward-compat hedge for a future Problems panel. Flattens every entry in
// byResource and byFile into a single located list. Trivial; locks the
// contract the panel will consume.
export function summarizeWorkspace(
  state: Pick<EditorState, "diagnostics">,
): DiagnosticsSummary | null;
```

`summarizeResource` and `summarizeFiles` share an internal implementation (collect located diagnostics across `filePaths`, optionally filter by name, derive `worstSeverity` + `count`). Kept as two exported functions because call sites read better with explicit names; DRY inside the module, not at the API.

### Expanding the module→files list for sidebar rows

`WorkspaceTree` needs the set of files each module spans (owner + partials) so it can call `summarizeFiles`. That set is already discoverable — [analysis.ts:46-60](apps/telo-editor/src/analysis.ts#L46-L60) walks `manifest.resources[].sourceFile` for the same purpose. Extract that logic into a small shared helper (`getModuleFiles(manifest)`) and call it from both sites.

## Components

### `DiagnosticBadge` (new)

Location: `apps/telo-editor/src/components/diagnostics/DiagnosticBadge.tsx`

Props:
```ts
interface DiagnosticBadgeProps {
  summary: DiagnosticsSummary | null;
  size?: "sm" | "md";                  // sm for sidebar/rows, md for headers
  showCount?: boolean;                 // default true
  onNavigate?: (filePath: string, range?: Range) => void;
  // When rendered inline next to text that is itself clickable (sidebar row
  // is a button), stop propagation so clicking the badge doesn't also
  // trigger row-click behavior.
  stopPropagation?: boolean;
}
```

Rendering:
- Returns `null` when `summary` is null.
- Trigger: a small `<span>` with the severity icon (`●` error / `▲` warning / `i` info), optional count, in red / amber / blue (reuse the palette from [InventoryView.tsx:70-74](apps/telo-editor/src/components/views/inventory/InventoryView.tsx#L70-L74)).
- Clicking the trigger opens a `Popover` whose content is `DiagnosticPopoverContent`.

### `DiagnosticPopoverContent` (new)

Location: `apps/telo-editor/src/components/diagnostics/DiagnosticPopoverContent.tsx`

Content layout (one block per diagnostic; list when multiple):
- Header row: severity chip + `code` (e.g. `UNKNOWN_KIND`) + `source` (e.g. `telo-analyzer`).
- Message: `<pre>` with `whitespace-pre-wrap`, `user-select: text`, monospace, wrapping. Not a `<p>` — some messages contain multi-line YAML snippets that should preserve newlines.
- File reference: clickable "Open in source" button calling `onNavigate(filePath, range?)`. Uses the `filePath` from `LocatedDiagnostic` (always present) and `diagnostic.range` (may be undefined — button still renders, reveals nothing). Label shows `file.yaml` plus `:line:col` when `range` is present. Field-path hints from `data.path` (e.g. `"kind"`, `"metadata.name"`) are rendered as secondary text only — they are NOT a filesystem path. **Suppress the button entirely when `filePath === UNKNOWN_FILE_KEY`** — those diagnostics have no navigable source; rendering a broken button would ship alongside the future Problems panel.
- Per-diagnostic "Copy" button — copies `message` only.
- Footer "Copy all" button when >1 diagnostic — copies all messages joined with blank lines, each prefixed with `[severity] code:`.

Copy implementation: `navigator.clipboard.writeText`. No toast UI — the button briefly flips label to "Copied" for 1.5s.

## Navigation

### `navigateToDiagnostic` (new method on Editor)

Signature: `(filePath: string, range?: Range) => void`

Implementation in [Editor.tsx](apps/telo-editor/src/components/Editor.tsx):
1. Resolve `filePath` to its owner module path. For owner files this is `filePath` itself; for partials, walk `workspace.modules` to find the module whose `getModuleFiles(manifest)` contains `filePath`. Store that as `activeModulePath`.
2. Set `activeView = "source"`.
3. Push a new state field: `sourceRevealRequest: { filePath: string; range: Range; nonce: number } | null`. SourceView consumes it.

### SourceView consumption

[SourceView.tsx](apps/telo-editor/src/components/views/source/SourceView.tsx) gains:
- A prop `revealRequest?: { filePath; range?; nonce }` threaded through `ViewProps`.
- A `lastConsumedNonceRef = useRef<number | null>(null)`.
- An effect with dependency array `[revealRequest?.nonce]` that:
  1. Short-circuits if `revealRequest == null` or `revealRequest.nonce === lastConsumedNonceRef.current`.
  2. Sets the active tab to `revealRequest.filePath` (if it exists in `sourceFiles`).
  3. When `range` is present, after mount of the corresponding Monaco editor, calls `editor.revealRangeInCenter({ startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 })` and `editor.setSelection(...)` for the same range.
  4. Writes `lastConsumedNonceRef.current = revealRequest.nonce`.

Keying the effect on `nonce` alone (not on the object identity) avoids firing on every Editor re-render. Tracking `lastConsumedNonceRef` avoids re-revealing when the user switches away from Source view and back (SourceView remounts with the same nonce — no wanted re-reveal).

`nonce` must increment on every navigation request, including repeat clicks on the same diagnostic (otherwise "re-reveal the place I just scrolled away from" doesn't work). Implementation: monotonic counter incremented in `navigateToDiagnostic`.

`sourceRevealRequest` is never cleared from state; the `lastConsumedNonceRef` handles idempotency.

## Integration sites

Every site gets a `DiagnosticBadge`. Each line lists the file + render location + which summary.

### Sidebar
- [WorkspaceTree.tsx:305-310](apps/telo-editor/src/components/sidebar/WorkspaceTree.tsx#L305-L310) — module row (Application or Library). Summary: `summarizeFiles(state, getModuleFiles(manifest))`.
- [ResourcesSection.tsx:47](apps/telo-editor/src/components/sidebar/ResourcesSection.tsx#L47) — per resource row. Summary: `summarizeResource(state, getModuleFiles(manifest), r.name)`. Passes the full file list so a resource declared in a partial is found even when the owner's path is selected.
- [DefinitionsSection.tsx:32](apps/telo-editor/src/components/sidebar/DefinitionsSection.tsx#L32) — per definition row. `summarizeResource(state, getModuleFiles(manifest), r.name)`.
- [ImportRow.tsx:45](apps/telo-editor/src/components/sidebar/ImportRow.tsx#L45) — import row. `summarizeResource(state, getModuleFiles(manifest), imp.name)`. Do **not** cross into the imported child module.

### Views
- [InventoryView.tsx:5-20](apps/telo-editor/src/components/views/inventory/InventoryView.tsx#L5-L20) — delete the local `DiagnosticIndicator`. Replace with `DiagnosticBadge` in both the resources table ([InventoryView.tsx:134](apps/telo-editor/src/components/views/inventory/InventoryView.tsx#L134)) and the definitions table ([InventoryView.tsx:202](apps/telo-editor/src/components/views/inventory/InventoryView.tsx#L202)). The left-border row styling at [InventoryView.tsx:70-74](apps/telo-editor/src/components/views/inventory/InventoryView.tsx#L70-L74) currently switches on `diagnostics.some(d => d.severity === Error)`; migrate it to read `summary?.worstSeverity === DiagnosticSeverity.Error` so row highlighting stays in sync with the badge.
- [ResourceCanvas.tsx:349](apps/telo-editor/src/components/views/canvas/ResourceCanvas.tsx#L349) — next to the `<h2>` resource name, size="md".
- [DetailPanel.tsx:165-166](apps/telo-editor/src/components/views/canvas/DetailPanel.tsx#L165-L166) — next to the panel title, size="md".
- [RouterTopologyCanvas.tsx:216](apps/telo-editor/src/components/views/topology/RouterTopologyCanvas.tsx#L216) — next to node name, size="sm".
- [SequenceTopologyCanvas.tsx:881](apps/telo-editor/src/components/views/topology/SequenceTopologyCanvas.tsx#L881) — next to node name, size="sm".

### TopBar
- [TopBar.tsx:52](apps/telo-editor/src/components/TopBar.tsx#L52) — next to the module name breadcrumb, size="sm". Summary is the whole-module rollup (same as WorkspaceTree row).

## Wiring `onNavigate`

`Editor` passes `navigateToDiagnostic` down through:
- `Sidebar` props → each sidebar subsection.
- `ViewContainer` props → each view receives it via `ViewProps` or a dedicated context.
- Already-used `selectedResource` / `onSelectResource` pattern is a good template for threading.

To avoid prop-drilling everywhere, introduce a tiny `DiagnosticsContext` (`React.createContext<{ navigate: ... }>`) provided once at the Editor level. `DiagnosticBadge` reads it directly; callers don't need to pass `onNavigate`.

## Edge cases

- **Diagnostic with no `range`.** "Open in source" button is rendered but opens the file with no reveal — just switches view and activates the right tab. Popover still renders the message.
- **Diagnostic with no resource `data`.** Routed to `byFile` (not dropped, unlike today). Surfaces on the module-level rollup (sidebar App/Library row) and on the TopBar breadcrumb, but on no resource row. Matches user intent — module name counts as a name.
- **Diagnostic with neither resource nor resolvable file.** Routed to `byFile[UNKNOWN_FILE_KEY]`. Not visible anywhere in this plan's UI sites (no name to attach to). Picked up by `summarizeWorkspace` so the future Problems panel catches them. Not a regression vs. today — today they're dropped entirely.
- **Stale diagnostics during a 300ms debounce.** Same behavior as today: the map reflects the last completed analysis pass. Badges flicker with it; acceptable.
- **Very long messages.** `<pre>` with `max-h-[60vh] overflow-auto` inside the popover. Copy still copies the full text.
- **Popover inside a clickable row** (sidebar rows are buttons). Badge wrapper uses `onClick={e => e.stopPropagation()}` and `onMouseDown={e => e.stopPropagation()}` so clicking the badge doesn't navigate the row.

## Work breakdown

1. **Analyzer → state shape change** — `analyzeWorkspace` returns `WorkspaceDiagnostics`; `EditorState.diagnosticsByResource` → `EditorState.diagnostics`; unscoped diagnostics routed to `byFile` instead of being dropped.
2. **Aggregation helper** — `diagnostics-aggregate.ts` with `summarizeResource`, `summarizeFiles`, `summarizeWorkspace`; extract shared `getModuleFiles(manifest)` from the logic at [analysis.ts:46-60](apps/telo-editor/src/analysis.ts#L46-L60).
3. **Badge + popover components** — `DiagnosticBadge`, `DiagnosticPopoverContent`, `DiagnosticsContext`.
4. **Navigation plumbing** — `sourceRevealRequest` on `EditorState`, `navigateToDiagnostic` in `Editor`, consumption in `SourceView` with `lastConsumedNonceRef`.
5. **Sidebar integration** — WorkspaceTree, ResourcesSection, DefinitionsSection, ImportRow.
6. **View integration** — ResourceCanvas, DetailPanel, both topology canvases, TopBar.
7. **Inventory migration** — replace local `DiagnosticIndicator` with `DiagnosticBadge`; switch left-border styling to read `summary?.worstSeverity`.

Steps 1-4 are sequential. Steps 5-7 can land in any order after 4.

## Forward-compat: Problems panel

With `WorkspaceDiagnostics.byFile` populated and `summarizeWorkspace` in place, a future Problems panel becomes a thin wrapper: iterate `byFile` and `byResource`, render each `LocatedDiagnostic` as a row with the existing `DiagnosticPopoverContent`, wire "Open in source" to the same `navigateToDiagnostic`. Not part of this plan — but the contract is locked in now so the panel doesn't require a second data-model pass.

## Testing plan

Manual (no UI unit-test harness exists in the editor today):
- Craft a manifest with (a) a resource error, (b) a definition warning, (c) a diagnostic on an included partial, (d) a manifest missing `kind` or `metadata.name` entirely (produces a diagnostic with no `data.resource` — today dropped; must now surface on the module rollup and TopBar).
- Verify the badge appears in every integration site listed above with the correct severity/count.
- Verify clicking the badge opens the popover, message is selectable and copy-pasteable.
- Verify "Open in source" switches to Source view, activates the correct tab (owner OR partial), and reveals the right line range.
- Verify clicking the badge inside a sidebar row does NOT navigate the row.
- Verify the import-row badge shows only the import's own diagnostics — not those of the imported module.
- Verify the Application/Library sidebar row rolls up both owner and partial diagnostics.
