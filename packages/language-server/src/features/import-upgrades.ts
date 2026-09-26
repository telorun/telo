import { withRefVersion } from "@telorun/analyzer";
import {
  TeloCommand,
  TeloMethod,
  type UpgradeImportsArguments,
} from "@telorun/editor-protocol";
import {
  buildImportUpgrades,
  createVersionCompatibility,
  describeReason,
  type ImportUpgradeEdit,
  type ImportUpgradeSet,
  type ImportUpgradeSkip,
  type ModuleVersion,
  type ModuleVersionLookup,
  type VersionCompatibilityCheck,
} from "@telorun/ide-support";
import type { CodeLens, TextEdit } from "vscode-languageserver/browser";
import { canonicalDocumentUri, sourceOfUri } from "../document-uri.js";
import type { HostClient } from "../host-client.js";
import type { FeatureContext } from "./context.js";

/** How long a module's version list stays usable before the hub is asked
 *  again. Lenses re-resolve on every edit and every scroll, so an uncached
 *  lookup would put the hub on the keystroke path; module versions move on a
 *  release cadence, so minutes-stale is invisible to the author. */
const VERSION_TTL_MS = 5 * 60 * 1000;

/** How long a FAILED lookup is remembered. A failure is cached too, or the
 *  throttle vanishes exactly when the network is worst — an unreachable hub
 *  would otherwise be asked once per import on every keystroke. Shorter than the
 *  success TTL so a transient outage clears quickly. */
const FAILURE_TTL_MS = 30 * 1000;

interface CacheEntry {
  at: number;
  /** The in-flight or settled lookup, shared by sibling imports of one module. */
  versions: Promise<ModuleVersion[]>;
  /** Recorded rather than inferred, so a pending entry is never mistaken for a
   *  failed one. */
  failed?: boolean;
}

/** Hub version lookups shared by every document, memoized with a TTL. */
class VersionCache {
  private readonly byRef = new Map<string, CacheEntry>();

  constructor(private readonly host: HostClient) {}

  lookup: ModuleVersionLookup = (baseRef) => {
    const now = Date.now();
    const hit = this.byRef.get(baseRef);
    if (hit && now - hit.at < (hit.failed ? FAILURE_TTL_MS : VERSION_TTL_MS)) return hit.versions;

    const versions = this.host.request(TeloMethod.hubListVersions, { ref: baseRef });
    const entry: CacheEntry = { at: now, versions };
    this.byRef.set(baseRef, entry);
    // Mark THIS entry: a refresh between the request and its failure may have
    // installed a newer lookup, and demoting that one would reopen the
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

/** A candidate version's `telo.yaml`, read through the host like any import —
 *  the host owns the transport that addresses the versioned ref. A ref with no
 *  version grammar, or one the host finds nothing at, answers `null`, which the
 *  check reads as "not known" and never as incompatible. */
function candidateReader(host: HostClient) {
  return async (baseRef: string, version: string): Promise<string | null> => {
    let ref: string;
    try {
      ref = withRefVersion(baseRef, version);
    } catch {
      return null;
    }
    const result = await host.request(TeloMethod.read, { uri: ref });
    return result?.text ?? null;
  };
}

/** What the author can do about a skipped upgrade, short enough for a lens —
 *  read off the skip's own reason, since only one of the two rejections is fixed
 *  by updating telo. */
function skipAction(skip: ImportUpgradeSkip): string {
  if (skip.code !== "incompatible") return "run `telo upgrade`";
  return skip.reason === "unreadable"
    ? "its declared requirement cannot be read"
    : "update telo to upgrade";
}

/** Both counts in one line, so the `imports:` key carries a single lens. */
function summaryTitle(outdated: number, unpinned: number): string {
  const parts: string[] = [];
  if (outdated > 0) parts.push(`${outdated} import${outdated === 1 ? "" : "s"} outdated`);
  if (unpinned > 0) parts.push(`${unpinned} unpinned`);
  return `${parts.join(", ")} · ${outdated > 0 ? "Upgrade all" : "Pin all"}`;
}

/**
 * Code lenses over a module document's `imports:` block — one summary lens on
 * the key and one per outdated, unpinned or held-back entry — and the commands
 * they run. A command recomputes against the document as it stands, applies
 * only the named aliases through `workspace/applyEdit`, and says why when
 * nothing applied: "nothing to do" and "could not find out" are different
 * answers.
 */
export function registerImportUpgrades({
  connection,
  documents,
  session,
  host,
  client,
}: FeatureContext): void {
  const versions = new VersionCache(host);
  let compatibility: VersionCompatibilityCheck = createVersionCompatibility(candidateReader(host));

  // A command's argument carries the canonical spelling, which the host may
  // have opened the document under another spelling of.
  const documentOf = (uri: string) =>
    documents.get(uri) ??
    documents.all().find((d) => canonicalDocumentUri(d.uri) === canonicalDocumentUri(uri));

  const upgradesFor = async (uri: string): Promise<ImportUpgradeSet | undefined> => {
    const document = documentOf(uri);
    let text: string;
    if (document) {
      text = document.getText();
    } else {
      const read = await host.request(TeloMethod.read, { uri });
      if (!read) return undefined;
      text = read.text;
    }
    const set = await buildImportUpgrades(
      text,
      { listVersions: versions.lookup, isCompatible: compatibility },
      session.documentAnalysis(sourceOfUri(uri)).docsFor(text),
    );
    for (const failure of set?.failures ?? []) {
      host.log(`[${sourceOfUri(uri)}] hub version lookup failed for ${failure.baseRef}: ${failure.message}`);
    }
    return set;
  };

  const refreshLenses = () => {
    if (!client.codeLensRefresh) return;
    connection.sendRequest("workspace/codeLens/refresh").catch((error: unknown) => {
      host.log(`telo: the client refused a code lens refresh: ${String(error)}`);
    });
  };

  connection.onCodeLens(async (params) => {
    const set = await upgradesFor(params.textDocument.uri);
    if (!set) return [];
    const uri = canonicalDocumentUri(params.textDocument.uri);
    const argument = (aliases: string[]): UpgradeImportsArguments => ({ uri, aliases });

    const lenses: CodeLens[] = set.upgrades.map((u) => {
      const pinNote = u.repinned
        ? `Upgrade ${u.alias} to ${u.latestVersion} and re-pin its integrity hash`
        : `Upgrade ${u.alias} to ${u.latestVersion} (the hub publishes no integrity pin for it)`;
      // A target short of the newest version says why, or the lens reads as the
      // tooling being behind rather than the runtime.
      const heldNote = u.heldBack
        ? ` · ${u.heldBack.version} held back: ${describeReason(u.heldBack.reason)}`
        : "";
      return {
        range: u.keyRange,
        command: {
          title: `↑ ${u.currentVersion} → ${u.latestVersion}${u.heldBack ? " ⚠" : ""}`,
          tooltip: `${pinNote}${heldNote}`,
          command: TeloCommand.upgradeImport,
          arguments: [argument([u.alias])],
        },
      };
    });
    // Current but unpinned: a different edit with a different risk — nothing
    // about the resolved module changes, it just becomes tamper-evident.
    for (const pin of set.pins) {
      lenses.push({
        range: pin.keyRange,
        command: {
          title: `+ pin ${pin.version}`,
          tooltip: `Pin ${pin.alias} to the integrity hash published for ${pin.version}`,
          command: TeloCommand.upgradeImport,
          arguments: [argument([pin.alias])],
        },
      });
    }
    // Behind but not rewritable here still gets a lens: silence would read as
    // "up to date", the one thing it is not.
    for (const skip of set.skipped) {
      lenses.push({
        range: skip.keyRange,
        command: {
          title: `⚠ ${skip.currentVersion} → ${skip.latestVersion} · ${skipAction(skip)}`,
          tooltip: skip.message,
          command: "",
        },
      });
    }
    const actionable = [...set.upgrades, ...set.pins];
    if (actionable.length > 0) {
      lenses.unshift({
        range: set.importsKeyRange,
        command: {
          title: summaryTitle(set.upgrades.length, set.pins.length),
          command: TeloCommand.upgradeAllImports,
          arguments: [argument(actionable.map((a) => a.alias))],
        },
      });
    }
    return lenses;
  });

  const apply = async (args: UpgradeImportsArguments): Promise<void> => {
    const set = await upgradesFor(args.uri);
    const wanted = new Set(args.aliases);
    const upgrades = (set?.upgrades ?? []).filter((u) => wanted.has(u.alias));
    const pins = (set?.pins ?? []).filter((p) => wanted.has(p.alias));
    const selected: Array<{ edits: ImportUpgradeEdit[] }> = [...upgrades, ...pins];

    if (selected.length === 0) {
      explainNothingApplied(set, wanted);
      return;
    }
    const edits: TextEdit[] = selected.flatMap((entry) =>
      entry.edits.map((e) => ({ range: e.range, newText: e.newText })),
    );
    const result = await connection.workspace.applyEdit({
      label: "Upgrade imports",
      edit: { changes: { [canonicalDocumentUri(args.uri)]: edits } },
    });
    if (!result.applied) {
      connection.window.showErrorMessage(
        `telo: could not apply the import upgrade to ${sourceOfUri(args.uri)}` +
          (result.failureReason ? ` — ${result.failureReason}` : "."),
      );
      return;
    }
    refreshLenses();
    const dropped = upgrades.filter((u) => u.wasPinned && !u.repinned).length;
    if (dropped > 0) {
      // The old hash covers the version that was replaced, so it was removed —
      // a loss that is otherwise invisible in the YAML.
      connection.window.showInformationMessage(
        `telo: removed the integrity pin from ${dropped} upgraded import${dropped === 1 ? "" : "s"} — ` +
          "the hub publishes no pin for the new version, and the old hash covers the version " +
          "that was replaced. Run `telo upgrade` to re-pin from the origin.",
      );
    }
  };

  const explainNothingApplied = (set: ImportUpgradeSet | undefined, wanted: Set<string>) => {
    if (!set) {
      connection.window.showErrorMessage("telo: could not read the imports of this document.");
      return;
    }
    if (set.failures.length > 0) {
      const detail = set.failures.map((f) => `${f.baseRef} (${f.message})`).join("; ");
      connection.window.showErrorMessage(`telo: could not check for updates — ${detail}`);
      return;
    }
    const skip = set.skipped.find((s) => wanted.has(s.alias));
    if (skip) {
      connection.window.showWarningMessage(`telo: ${skip.reason}`);
      return;
    }
    connection.window.showInformationMessage("telo: those imports are already up to date.");
  };

  connection.onExecuteCommand(async (params) => {
    switch (params.command) {
      case TeloCommand.upgradeImport:
      case TeloCommand.upgradeAllImports:
        await apply(params.arguments?.[0] as UpgradeImportsArguments);
        return null;
      case TeloCommand.refreshImportUpgrades:
        versions.clear();
        compatibility = createVersionCompatibility(candidateReader(host));
        refreshLenses();
        return null;
      default:
        throw new Error(`telo: unknown command '${params.command}'.`);
    }
  });
}
