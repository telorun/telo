import {
  buildImportUpgrades,
  type ImportUpgradeEdit,
  type ImportUpgradeSet,
  type ModuleVersion,
  type ModuleVersionLookup,
  type Range as TeloRange,
} from "@telorun/ide-support";
import * as vscode from "vscode";
import { TeloAnalysisCache } from "./analysis-cache.js";
import { fetchHubVersions } from "./ide-adapter.js";

export const UPGRADE_IMPORT_COMMAND = "telo.upgradeImport";
export const UPGRADE_ALL_IMPORTS_COMMAND = "telo.upgradeAllImports";
export const REFRESH_IMPORT_UPGRADES_COMMAND = "telo.refreshImportUpgrades";

/** Opt-out for the whole feature — it is the only thing here that reaches the
 *  network on its own initiative, so it gets a switch. */
function lensesEnabled(): boolean {
  return vscode.workspace.getConfiguration("telo").get<boolean>("importUpgrades.enabled") ?? true;
}

/** How long a module's version list stays usable before the hub is asked
 *  again. CodeLenses re-resolve on every edit and on every scroll into view, so
 *  an uncached lookup would put the hub on the keystroke path. Module versions
 *  move on a release cadence, so minutes-stale is invisible to the author. */
const VERSION_TTL_MS = 5 * 60 * 1000;

/** How long a FAILED lookup is remembered. A failure has to be cached too, or
 *  the throttle vanishes exactly when the network is worst: an unreachable hub
 *  (or a wrong `telo.hubUrl`, or an air-gapped machine) would otherwise fire a
 *  fresh request per base ref on every keystroke. Shorter than the success TTL
 *  so a transient outage still clears quickly. */
const FAILURE_TTL_MS = 30 * 1000;

interface CacheEntry {
  at: number;
  /** The in-flight or settled lookup. Stored as the promise so concurrent lens
   *  resolutions for sibling imports of the same module share one request
   *  instead of racing several. */
  versions: Promise<ModuleVersion[]>;
  /** Set once the lookup is known to have rejected, which shortens its TTL.
   *  Recorded rather than inferred so a pending entry is never mistaken for a
   *  failed one. */
  failed?: boolean;
}

/** Command arguments. The aliases are re-resolved against the document's
 *  current text when the command runs, so a lens clicked after an edit can
 *  never apply a range that has since moved. */
interface UpgradeArgs {
  uri: string;
  aliases: string[];
}

/** Hub version lookups shared by every document, memoized with a TTL.
 *  Deliberately separate from `VsCodeIdeAdapter`: completion wants whatever the
 *  hub says the moment the popup opens, while lenses re-resolve constantly —
 *  same endpoint, different refresh policy. */
class VersionCache {
  private readonly byRef = new Map<string, CacheEntry>();

  lookup: ModuleVersionLookup = (baseRef) => {
    const now = Date.now();
    const hit = this.byRef.get(baseRef);
    if (hit && now - hit.at < (hit.failed ? FAILURE_TTL_MS : VERSION_TTL_MS)) {
      return hit.versions;
    }

    const versions = fetchHubVersions(baseRef);
    const entry: CacheEntry = { at: now, versions };
    this.byRef.set(baseRef, entry);
    // Mark THIS entry, never whatever is in the map when the rejection lands:
    // a `refresh()` (or an elapsed TTL) between the request and its failure can
    // have installed a newer lookup, and demoting that one would re-open the
    // per-keystroke retry this TTL exists to close.
    versions.catch(() => {
      if (this.byRef.get(baseRef) === entry) entry.failed = true;
    });
    return versions;
  };

  clear(): void {
    this.byRef.clear();
  }
}

function toVscodeRange(r: TeloRange): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

/** CodeLenses over a module document's `imports:` block: one summary lens on
 *  the `imports:` key and one per outdated entry. The version source is the
 *  telo hub (`GET /module/versions`), reached through the same host adapter
 *  that backs import-source completion. */
export class TeloImportUpgradeLensProvider implements vscode.CodeLensProvider {
  private readonly versions = new VersionCache();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly output: vscode.OutputChannel;
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(
    private readonly cache: TeloAnalysisCache,
    output: vscode.OutputChannel,
  ) {
    this.output = output;
  }

  /** Drops every memoized version list and re-resolves the visible lenses. */
  refresh(): void {
    this.versions.clear();
    this.changed.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!lensesEnabled()) return [];
    const set = await this.upgradesFor(document);
    if (!set) return [];
    if (set.upgrades.length === 0 && set.pins.length === 0 && set.skipped.length === 0) return [];

    const uri = document.uri.toString();
    const lenses = set.upgrades.map(
      (u) =>
        new vscode.CodeLens(toVscodeRange(u.keyRange), {
          title: `↑ ${u.currentVersion} → ${u.latestVersion}`,
          tooltip: u.repinned
            ? `Upgrade ${u.alias} to ${u.latestVersion} and re-pin its integrity hash`
            : `Upgrade ${u.alias} to ${u.latestVersion} (the hub publishes no integrity pin for it)`,
          command: UPGRADE_IMPORT_COMMAND,
          arguments: [{ uri, aliases: [u.alias] } satisfies UpgradeArgs],
        }),
    );

    // An import at the newest version but carrying no hash. Offered separately
    // from an upgrade because it is a different edit with a different risk:
    // nothing about the resolved module changes, the version it already
    // resolves to simply becomes tamper-evident.
    for (const pin of set.pins) {
      lenses.push(
        new vscode.CodeLens(toVscodeRange(pin.keyRange), {
          title: `+ pin ${pin.version}`,
          tooltip: `Pin ${pin.alias} to the integrity hash published for ${pin.version}`,
          command: UPGRADE_IMPORT_COMMAND,
          arguments: [{ uri, aliases: [pin.alias] } satisfies UpgradeArgs],
        }),
      );
    }

    // An import that is behind but cannot be rewritten here still gets a lens.
    // Silence would read as "up to date", which is the one thing it is not.
    for (const skip of set.skipped) {
      lenses.push(
        new vscode.CodeLens(toVscodeRange(skip.keyRange), {
          title: `⚠ ${skip.currentVersion} → ${skip.latestVersion} · run \`telo upgrade\``,
          tooltip: skip.reason,
          command: "",
        }),
      );
    }

    const actionable = [...set.upgrades, ...set.pins];
    if (actionable.length > 0) {
      lenses.unshift(
        new vscode.CodeLens(toVscodeRange(set.importsKeyRange), {
          title: summaryTitle(set.upgrades.length, set.pins.length),
          command: UPGRADE_ALL_IMPORTS_COMMAND,
          arguments: [
            { uri, aliases: actionable.map((a) => a.alias) } satisfies UpgradeArgs,
          ],
        }),
      );
    }

    return lenses;
  }

  /** Runs the shared builder over the document's current text, reusing the
   *  analysis pass's AST when the buffer hasn't moved since. */
  private async upgradesFor(
    document: vscode.TextDocument,
  ): Promise<ImportUpgradeSet | undefined> {
    const text = document.getText();
    const set = await buildImportUpgrades(
      text,
      this.versions.lookup,
      this.cache.docsFor(document.uri.fsPath, text),
    );

    for (const failure of set?.failures ?? []) {
      this.output.appendLine(
        `[${document.uri.fsPath}] hub version lookup failed for ${failure.baseRef}: ${failure.message}`,
      );
    }
    return set;
  }

  /** Command handler for every lens. Recomputes against the document as it
   *  stands now and applies only the named aliases, whichever category each
   *  turns out to be in — an alias is one import, and what it needs is the
   *  builder's answer, not the clicked lens's. */
  async apply(args: UpgradeArgs): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri));
    const set = await this.upgradesFor(document);
    const wanted = new Set(args.aliases);
    const upgrades = (set?.upgrades ?? []).filter((u) => wanted.has(u.alias));
    const pins = (set?.pins ?? []).filter((p) => wanted.has(p.alias));
    const selected: Array<{ edits: ImportUpgradeEdit[] }> = [...upgrades, ...pins];

    if (selected.length === 0) {
      // "Nothing to do" and "we could not find out" are different answers, and
      // reporting the second as the first states a fact that was never checked.
      // A failed lookup is the common case here: the click lands after a
      // rejected lookup shortened the entry's TTL, so it refetches and can fail
      // again.
      await this.explainNothingApplied(set, wanted);
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const entry of selected) {
      for (const e of entry.edits) {
        edit.replace(document.uri, toVscodeRange(e.range), e.newText);
      }
    }

    if (!(await vscode.workspace.applyEdit(edit))) {
      vscode.window.showErrorMessage(
        `telo: could not apply the import upgrade to ${document.uri.fsPath}.`,
      );
      return;
    }

    this.changed.fire();
    notifyDroppedPins(upgrades.filter((u) => u.wasPinned && !u.repinned).length);
  }

  /** Says why an upgrade click changed nothing, in the order that matters to
   *  the author: a lookup that failed, then a skip that named a reason, then —
   *  only once neither applies — genuinely current. */
  private async explainNothingApplied(
    set: ImportUpgradeSet | undefined,
    wanted: Set<string>,
  ): Promise<void> {
    if (!set) {
      vscode.window.showErrorMessage(
        "telo: could not read the imports of this document. See the Telo output channel.",
      );
      return;
    }

    if (set.failures.length > 0) {
      const detail = set.failures
        .map((f) => `${f.baseRef} (${f.message})`)
        .join("; ");
      const choice = await vscode.window.showErrorMessage(
        `telo: could not check for updates — ${detail}`,
        "Show Log",
      );
      if (choice === "Show Log") this.output.show(true);
      return;
    }

    const skip = set.skipped.find((s) => wanted.has(s.alias));
    if (skip) {
      vscode.window.showWarningMessage(`telo: ${skip.reason}`);
      return;
    }

    vscode.window.showInformationMessage("telo: those imports are already up to date.");
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** Both counts in one line, so the `imports:` key carries a single lens no
 *  matter which mix of work the block needs. */
function summaryTitle(outdated: number, unpinned: number): string {
  const parts: string[] = [];
  if (outdated > 0) parts.push(`${outdated} import${outdated === 1 ? "" : "s"} outdated`);
  if (unpinned > 0) parts.push(`${unpinned} unpinned`);
  return `${parts.join(", ")} · ${outdated > 0 ? "Upgrade all" : "Pin all"}`;
}

/** An upgraded import's `integrity:` hash covers the version that was replaced,
 *  so it is dropped rather than carried forward. Normally the hub publishes a
 *  pin for the new version and the rewrite re-pins in the same edit; this is
 *  the residual case where it has none. Say so — the loss is otherwise
 *  invisible in the YAML. */
function notifyDroppedPins(count: number): void {
  if (count === 0) return;
  vscode.window.showInformationMessage(
    `telo: removed the integrity pin from ${count} upgraded import${count === 1 ? "" : "s"} — ` +
      "the hub publishes no pin for the new version, and the old hash covers the version " +
      "that was replaced. Run `telo upgrade` to re-pin from the origin.",
  );
}
