import { isSameModuleVersion, parseVersionedRef } from "@telorun/analyzer";
import { describeRemedy } from "@telorun/ide-support";
import { ArrowUp, ChevronLeft, ExternalLink, GitBranch, Pencil, Plus, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  bindingEntrySchema,
  importEntrySchema,
  portEntrySchema,
} from "../../../application-adapter";
import type { ImportableLibrary } from "../../../loader";
import type {
  AvailableKind,
  ModuleViewData,
  ParsedImport,
  ParsedResource,
  Selection,
} from "../../../model";
import {
  blockedMessage,
  upgradeActionTitle,
  versionPickerTitle,
} from "../../sidebar/import-upgrade-notices";
import { isImportPinned, upgradedImportSource } from "../../sidebar/import-pin";
import { useImportUpgrade } from "../../sidebar/useImportUpgrade";
import { useModuleVersions } from "../../sidebar/useModuleVersions";
import { useUpgradeTargets } from "../../sidebar/useUpgradeTargets";
import { useVersionCompatibility } from "../../sidebar/useVersionCompatibility";
import { AddImportDialog } from "../../AddImportDialog";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  bindingChips,
  bindingNameError,
  exportCandidates,
  exportChips,
  freshBindingName,
  withBinding,
  withExport,
  withoutBinding,
  withoutExport,
  type BindingBlock,
  type DeclarationChip,
  type ExportGroup,
} from "./module-declarations";

/**
 * What the module DECLARES, beside the canvas that shows what it RUNS.
 *
 * It belongs to the topology host rather than to any one view, and that
 * placement is the load-bearing part. A node lives in one view's coordinate
 * system and has to be laid out, sized, and laid out again at every focus depth;
 * this sits in the same place at any zoom, in every view — including views
 * nobody has written yet. Neither canvas grows a line for it.
 *
 * It NAVIGATES rather than edits: a chip opens a pointer-scoped selection and
 * the detail panel renders the form, which is the same split the canvas already
 * uses and the reason this adds no editor of its own. The Imports and Deployment
 * tabs stay the full editors — version upgrades, per-environment values — and
 * cannot drift from this, because all three write through the same operations.
 */
export function ModuleBar({
  viewData,
  root,
  readOnly,
  hubUrl,
  manifestCacheUrl,
  importableLibraries,
  selection,
  onAddImport,
  onRenameField,
  onRemoveImport,
  onUpgradeImport,
  onUpgradeAllImports,
  onOpenModule,
  onUpdateResource,
  onCreateResourceOfKind,
  onSelect,
}: {
  viewData: ModuleViewData;
  /** The synthesized module-root resource — what every edit writes through. */
  root: ParsedResource;
  readOnly: boolean;
  hubUrl: string | undefined;
  manifestCacheUrl: string | undefined;
  importableLibraries: ImportableLibrary[];
  selection: Selection | null;
  onAddImport: (source: string, alias: string) => Promise<void>;
  /** Renames one mapping key in place, preserving its position and comments. */
  onRenameField: (
    target: { kind: string; name: string },
    pointer: string,
    newKey: string,
  ) => void;
  onRemoveImport: (name: string) => void;
  onUpgradeImport: (name: string, newSource: string) => Promise<void>;
  onUpgradeAllImports: (updates: { name: string; newSource: string }[]) => Promise<void>;
  onOpenModule: (filePath: string) => void;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  /** Creates an empty resource of one kind, under a generated name, and focuses
   *  it — what an import row's kind menu does. */
  onCreateResourceOfKind: (kind: string) => void;
  onSelect: (selection: Selection) => void;
}) {
  const [open, setOpen] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  // The same lookups the imports view uses, so an import added here is gated on
  // compatibility exactly as one added there — an import pinned at a version
  // this runtime cannot host is a manifest that fails at the load gate seconds
  // later, and which surface added it must not change that.
  const listVersions = useModuleVersions(hubUrl);
  const isCompatible = useVersionCompatibility(manifestCacheUrl);
  // The same two hooks the Imports view drives, so an upgrade applied here and
  // one applied there move an import to the same version and write the same
  // pin — which version an import may move to is not a property of the surface
  // that asked. This offers only the ONE-CLICK move to the newest hostable
  // version; picking an arbitrary version, and the held-back explanations, stay
  // in the Imports view, which has room to say why.
  const targets = useUpgradeTargets(viewData.manifest.imports, listVersions, isCompatible);
  const upgrade = useImportUpgrade(listVersions, isCompatible, onUpgradeImport, onUpgradeAllImports);

  const manifest = viewData.manifest;
  const isApplication = manifest.kind === "Application";
  const fields = root.fields;

  // Only versions this telo can host are offered — "Upgrade all" must not walk
  // the author into a manifest their runtime refuses to load.
  const outdated = readOnly
    ? []
    : manifest.imports.flatMap((imp) => {
        const best = targets.get(imp.name)?.best;
        if (!best) return [];
        return [
          {
            name: imp.name,
            newSource: upgradedImportSource(imp, best),
            wasPinned: isImportPinned(imp),
            repinned: best.integrity != null,
          },
        ];
      });

  // Imports that ARE behind but have nothing hostable to move to. Reported for
  // the block rather than per row: a row's controls can only say "not offered",
  // and the action — update telo — is the same for all of them.
  const blocked = manifest.imports.flatMap((imp) => {
    const target = targets.get(imp.name);
    return target && !target.best && target.heldBack ? [{ name: imp.name, ...target.heldBack }] : [];
  });

  const write = (next: Record<string, unknown>) => onUpdateResource(root.kind, root.name, next);

  // The kinds each import brings in, keyed by the alias they arrive under —
  // which is the import row's own name, so a row can offer what importing it
  // made available. Read off the same `viewData.kinds` the create-resource
  // modal picks from, so the two surfaces can never offer different kinds.
  const kindsByAlias = useMemo(() => {
    const byAlias = new Map<string, AvailableKind[]>();
    for (const kind of viewData.kinds.values()) {
      const list = byAlias.get(kind.alias);
      if (list) list.push(kind);
      else byAlias.set(kind.alias, [kind]);
    }
    for (const list of byAlias.values()) list.sort((a, b) => a.kindName.localeCompare(b.kindName));
    return byAlias;
  }, [viewData.kinds]);

  /** Opens the entry's form in the detail panel — the panel is the editor. */
  const selectEntry = (block: BindingBlock, name: string) =>
    onSelect({
      resource: { kind: root.kind, name: root.name },
      pointer: `/${block}/${name}`,
      schema: block === "ports" ? portEntrySchema() : bindingEntrySchema(isApplication),
    });

  /** An import's entry, in the same panel the binding chips open. It is a
   *  mapping entry on the module root exactly as a variable is, so it navigates
   *  the same way rather than growing an editor here. */
  const selectImport = (imp: ParsedImport) =>
    onSelect({
      resource: { kind: root.kind, name: root.name },
      pointer: `/imports/${imp.name}`,
      // Typed from what the library itself declares, so the form offers that
      // library's real inputs rather than a free-form blob.
      schema: importEntrySchema(imp, viewData.importedConfig.get(imp.name)),
    });

  /** An import row's own buttons. Upgrade comes first — it is the one that
   *  reports something rather than merely offering something. */
  const importActions = (imp: ParsedImport) => {
    const out: {
      key: string;
      icon: React.ReactNode;
      title: string;
      onClick: () => void;
      tone?: "default" | "alert" | "danger";
    }[] = [];
    const best = readOnly ? null : targets.get(imp.name)?.best;
    if (best) {
      out.push({
        key: "upgrade",
        icon: <ArrowUp className="size-4" />,
        title: upgradeActionTitle(imp.name, best.version, targets.get(imp.name)?.heldBack),
        onClick: () => void upgrade.selectVersion(imp, best),
        tone: "alert",
      });
    }
    if (imp.resolvedPath) {
      out.push({
        key: "open",
        icon: <ExternalLink className="size-3.5" />,
        title: `Open ${imp.resolvedPath}`,
        onClick: () => onOpenModule(imp.resolvedPath!),
      });
    }
    return out;
  };

  /** Every published version of an import, each marked with whether this telo
   *  can host it. The one-click action moves to the newest hostable version; a
   *  DELIBERATE pick is a different act — an author may knowingly pin a version
   *  for a telo they are about to have — so the list offers the unhostable ones
   *  too, labelled. Fetched when the menu opens, never before. */
  const versionMenu = (imp: ParsedImport): ChipMenu | null => {
    const ref = parseVersionedRef(imp.source);
    if (!ref || readOnly) return null;
    const heldBack = targets.get(imp.name)?.heldBack ?? null;
    const active = upgrade.activeName === imp.name;
    const items: ChipMenuItem[] = [];
    if (active && upgrade.loading) {
      items.push({ key: "loading", label: "Loading…", message: true });
    }
    if (active && upgrade.error) {
      items.push({ key: "error", label: upgrade.error, message: true });
    }
    // A list where every row is marked explains nothing on its own.
    if (active && !upgrade.loading && upgrade.noneRunnable) {
      items.push({
        key: "none-runnable",
        message: true,
        label: `${
          upgrade.noneRunnable === "unreadable"
            ? "No published version can be checked — their declared requirements cannot be read."
            : "No published version runs on this telo."
        } ${describeRemedy(upgrade.noneRunnable)}`,
      });
    }
    if (active && !upgrade.loading) {
      for (const version of upgrade.versions) {
        const current = isSameModuleVersion(version.version, ref.version);
        items.push({
          key: version.version,
          label: version.version,
          note: current
            ? "current"
            : version.compatibility === "too-new"
              ? "needs newer telo"
              : version.compatibility === "unreadable"
                ? "unreadable"
                : undefined,
          noteTone: current ? "muted" : "warn",
          title:
            version.compatibility === "too-new"
              ? `${version.version} requires a newer telo than this one`
              : version.compatibility === "unreadable"
                ? `${version.version} declares a requirement that cannot be read`
                : undefined,
          disabled: upgrade.submitting,
          onSelect: () => void upgrade.selectVersion(imp, version),
        });
      }
    }
    return {
      key: "versions",
      title: versionPickerTitle(imp.name, ref.version, heldBack),
      icon: <GitBranch className="size-3.5" />,
      label: "Versions",
      onOpenChange: (open) => open && upgrade.loadVersions(imp),
      items,
    };
  };

  /** The two menus an import row carries: what importing it made available, and
   *  which version of it is pinned. */
  const importMenus = (imp: ParsedImport): ChipMenu[] => {
    const out: ChipMenu[] = [];
    const kinds = readOnly ? [] : (kindsByAlias.get(imp.name) ?? []);
    if (kinds.length > 0) {
      out.push({
        key: "kinds",
        title: `Create a resource from ${imp.name}`,
        icon: <Plus className="size-4" />,
        items: kinds.map((kind) => ({
          key: kind.fullKind,
          label: kind.kindName,
          detail: kind.capability.replace("Telo.", ""),
          onSelect: () => onCreateResourceOfKind(kind.fullKind),
        })),
      });
    }
    const versions = versionMenu(imp);
    if (versions) out.push(versions);
    return out;
  };

  const addBinding = (block: BindingBlock, base: string) => {
    const name = freshBindingName(fields, block, base);
    write(withBinding(fields, block, name, isApplication));
    selectEntry(block, name);
  };

  /** A key is the entry's identity, so a rename is its OWN operation rather than
   *  a field write: diffed as data it reads as "delete one key, add another",
   *  which appends the entry at the end of its block and re-serializes its value
   *  from plain data, losing the author's comments and quote style. The open
   *  selection moves with the key, or the panel would go on editing a pointer
   *  that no longer resolves. */
  const renameEntry = (block: BindingBlock, from: string, to: string) => {
    onRenameField({ kind: root.kind, name: root.name }, `/${block}/${from}`, to);
    if (isSelected(selection, root, `/${block}/${from}`)) selectEntry(block, to);
  };

  /** One binding block's chips — the three differ only in their block. */
  const bindingSection = (block: BindingBlock) =>
    bindingChips(fields, block).map((chip) => (
      <Chip
        key={chip.name}
        chip={chip}
        active={isSelected(selection, root, `/${block}/${chip.name}`)}
        onOpen={() => selectEntry(block, chip.name)}
        onRename={
          readOnly
            ? undefined
            : {
                validate: (next) => bindingNameError(fields, block, chip.name, next),
                commit: (next) => renameEntry(block, chip.name, next),
              }
        }
        onRemove={readOnly ? undefined : () => write(withoutBinding(fields, block, chip.name))}
      />
    ));

  if (!open) {
    return (
      <button
        className="flex h-full w-6 shrink-0 items-center justify-center border-r border-zinc-200 text-zinc-400 hover:text-zinc-600 dark:border-zinc-800"
        onClick={() => setOpen(true)}
        title="Show module declarations"
      >
        <Settings2 className="size-4" />
      </button>
    );
  }

  return (
    <div
      // `pr-1.5` is the scrollbar's own lane. An OVERLAY scrollbar (Chromium and
      // GTK on Linux, macOS always) paints over the content box rather than
      // shrinking it, so without a gutter it lands on whatever sits at the right
      // edge — a section's add button, a chip's remove. `scrollbar-gutter` is no
      // help: the spec fixes it at zero for overlay scrollbars, so it reserves
      // space only on the platforms that never had the problem.
      className="flex h-full w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-200 bg-white pr-1.5 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="truncate text-xs font-semibold text-zinc-700 dark:text-zinc-200">
          {manifest.metadata.name}
        </span>
        <span className="flex items-center gap-1">
          <span className="shrink-0 rounded bg-zinc-100 px-1 text-[9px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {manifest.kind}
          </span>
          <button
            className="text-zinc-400 hover:text-zinc-600"
            onClick={() => setOpen(false)}
            title="Collapse"
          >
            <ChevronLeft className="size-3.5" />
          </button>
        </span>
      </div>

      <Section
        title="Imports"
        onAdd={readOnly ? undefined : () => setAddOpen(true)}
        addTitle="Add an import"
        action={
          outdated.length > 0
            ? {
                icon: <ArrowUp className="size-3.5" />,
                title: upgrade.submitting
                  ? "Upgrading…"
                  : `Upgrade all ${outdated.length} outdated imports`,
                onClick: () => void upgrade.upgradeAll(outdated),
                disabled: upgrade.submitting,
              }
            : undefined
        }
      >
        {/* An upgrade can fail (an unreachable registry, a rewrite that would
            collide) and it can succeed while dropping a pin the YAML no longer
            shows. Neither is visible in the rows above, so both are reported
            here rather than left to the Imports view — the action was taken
            from this surface. */}
        {/* Behind with nothing hostable to move to: the rows can only fail to
            offer an upgrade, which reads as "up to date". Said once for the
            block, because the remedy — update telo — is the same for all. */}
        {blocked.length > 0 && (
          <div className="mb-1 rounded bg-amber-50 px-1.5 py-1 text-[10px] leading-tight text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            {blockedMessage(blocked)}
          </div>
        )}
        {(upgrade.submitError || upgrade.pinNotice) && (
          <button
            className="mb-1 block w-full rounded bg-amber-50 px-1.5 py-1 text-left text-[10px] leading-tight text-amber-700 dark:bg-amber-950 dark:text-amber-300"
            onClick={upgrade.dismissNotices}
            title="Dismiss"
          >
            {upgrade.submitError ?? upgrade.pinNotice}
          </button>
        )}
        {manifest.imports.map((imp) => (
          <Chip
            key={imp.name}
            // The ref itself is long, near-identical between rows and unreadable
            // at this width — twelve imports of one org differ in their last few
            // characters, which is the part that gets truncated away. What the
            // rail can usefully say is where the module comes FROM; the ref
            // stays one hover away, and the Imports view prints it in full.
            chip={{ name: imp.name }}
            badge={imp.importKind}
            openTitle={imp.source}
            // Clicking the row opens the entry, as every other row here does.
            // Opening the imported library is a NAVIGATION out of this module —
            // a different act, so it is its own button rather than the row's
            // primary click. An import authored as a standalone `Telo.Import`
            // document is not part of the root's fields (see
            // `inlineImportEntries`), so there is nothing for the panel to edit.
            onOpen={imp.inline ? () => selectImport(imp) : undefined}
            active={isSelected(selection, root, `/imports/${imp.name}`)}
            // An available upgrade holds the cluster open: it is information the
            // row is reporting, not an affordance that merely exists.
            alert={!readOnly && !!targets.get(imp.name)?.best}
            actions={importActions(imp)}
            onRemove={readOnly ? undefined : () => onRemoveImport(imp.name)}
            // Declaring an import and using it are one gesture here: the kinds
            // it exports are exactly the kinds this module gained, and the only
            // thing a create flow would still ask for is a name it can derive.
            menus={importMenus(imp)}
          />
        ))}
      </Section>

      <Section
        title="Variables"
        onAdd={readOnly ? undefined : () => addBinding("variables", "newVariable")}
        addTitle="Declare a variable"
      >
        {bindingSection("variables")}
      </Section>

      <Section
        title="Secrets"
        onAdd={readOnly ? undefined : () => addBinding("secrets", "newSecret")}
        addTitle="Declare a secret"
      >
        {bindingSection("secrets")}
      </Section>

      {/* Ports are Application-only; a Library declares its public surface
          instead. Two different blocks, so two different sections rather than
          one that changes meaning with the module kind. */}
      {isApplication ? (
        <Section
          title="Ports"
          onAdd={readOnly ? undefined : () => addBinding("ports", "http")}
          addTitle="Declare an inbound port"
        >
          {bindingSection("ports")}
        </Section>
      ) : (
        <>
          <ExportSection
            title="Exported kinds"
            group="kinds"
            manifest={manifest}
            fields={fields}
            readOnly={readOnly}
            onWrite={write}
          />
          <ExportSection
            title="Exported resources"
            group="resources"
            manifest={manifest}
            fields={fields}
            readOnly={readOnly}
            onWrite={write}
          />
        </>
      )}

      <AddImportDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        hubUrl={hubUrl}
        listVersions={listVersions}
        isCompatible={isCompatible}
        libraries={importableLibraries}
        existingAliases={manifest.imports.map((imp) => imp.name)}
        onSubmit={onAddImport}
      />
    </div>
  );
}

/** Whether a chip is the entry the detail panel currently has open. */
function isSelected(
  selection: Selection | null,
  root: ParsedResource,
  pointer: string,
): boolean {
  return (
    selection?.resource.kind === root.kind &&
    selection?.resource.name === root.name &&
    selection?.pointer === pointer
  );
}

/** A Library's public surface. Unlike a binding, an entry is a NAME the module
 *  already declares elsewhere, so adding one is a pick from what exists rather
 *  than a form — which is also what stops an export naming nothing. */
function ExportSection({
  title,
  group,
  manifest,
  fields,
  readOnly,
  onWrite,
}: {
  title: string;
  group: ExportGroup;
  manifest: ModuleViewData["manifest"];
  fields: Record<string, unknown>;
  readOnly: boolean;
  onWrite: (next: Record<string, unknown>) => void;
}) {
  const candidates = exportCandidates(manifest, fields, group);
  return (
    <Section
      title={title}
      addTitle={`Export ${group === "kinds" ? "a kind" : "an instance"}`}
      addMenu={
        readOnly || candidates.length === 0
          ? undefined
          : candidates.map((name) => ({
              name,
              onSelect: () => onWrite(withExport(fields, group, name)),
            }))
      }
    >
      {exportChips(fields, group).map((chip) => (
        <Chip
          key={chip.detail ?? chip.name}
          chip={chip}
          onRemove={
            readOnly ? undefined : () => onWrite(withoutExport(fields, group, chip.detail ?? chip.name))
          }
        />
      ))}
    </Section>
  );
}

function Section({
  title,
  onAdd,
  addMenu,
  addTitle,
  action,
  children,
}: {
  title: string;
  onAdd?: () => void;
  /** Pick-from-existing alternative to `onAdd`, for a list whose entries name
   *  something the module already declares. */
  addMenu?: { name: string; onSelect: () => void }[];
  addTitle: string;
  /** One block-wide action beside the add button — something that acts on every
   *  row at once, which no row can offer for itself. */
  action?: { icon: React.ReactNode; title: string; onClick: () => void; disabled?: boolean };
  children: React.ReactNode;
}) {
  // Falsy entries are conditionals that rendered nothing (a notice with nothing
  // to report), not content — counting them would suppress the "None" a genuinely
  // empty block owes the reader.
  const empty = Array.isArray(children)
    ? children.flat().filter(Boolean).length === 0
    : !children;
  return (
    <div className="border-t border-zinc-100 px-2 py-1.5 dark:border-zinc-900">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          {title}
        </span>
        <span className="flex items-center gap-1">
        {action && (
          <button
            className="text-amber-600 hover:text-amber-700 disabled:opacity-50 dark:text-amber-400 dark:hover:text-amber-300"
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
          >
            {action.icon}
          </button>
        )}
        {addMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title={addTitle}>
                <Plus className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
              {addMenu.map((item) => (
                <DropdownMenuItem key={item.name} className="text-xs" onSelect={item.onSelect}>
                  {item.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : onAdd ? (
          <button
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            onClick={onAdd}
            title={addTitle}
          >
            <Plus className="size-3.5" />
          </button>
        ) : null}
        </span>
      </div>
      {empty ? (
        <span className="text-[11px] text-zinc-300 dark:text-zinc-600">None</span>
      ) : (
        <div className="flex flex-col gap-0.5">{children}</div>
      )}
    </div>
  );
}

/** One button in a row's hover cluster. */
interface ChipAction {
  key: string;
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  tone?: "default" | "alert" | "danger";
}

/** Shared chrome for a cluster button. Sized as a real hit target rather than a
 *  bare glyph: these sit at the edge of a 224px rail, and a 12px icon with no
 *  padding is both hard to see and hard to hit. */
const ACTION_CLASS =
  "flex size-6 shrink-0 items-center justify-center rounded transition-colors";

const ACTION_TONE: Record<NonNullable<ChipAction["tone"]>, string> = {
  default:
    "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100",
  alert:
    "text-amber-600 hover:bg-amber-100 hover:text-amber-700 dark:text-amber-400 dark:hover:bg-amber-950 dark:hover:text-amber-300",
  danger:
    "text-zinc-500 hover:bg-red-100 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-red-950 dark:hover:text-red-400",
};

/** A row's own actions, offered as a menu beside it rather than as a section
 *  button: what it lists belongs to THIS entry, not to the block. A row may
 *  carry several — creating from an import's kinds and choosing its version are
 *  two different questions about the same row. */
interface ChipMenu {
  key: string;
  title: string;
  icon: React.ReactNode;
  /** Heading above the items, for a menu whose entries are values rather than
   *  actions (a version list). */
  label?: string;
  /** Fired when the menu opens, for a list that is fetched on demand. */
  onOpenChange?: (open: boolean) => void;
  items: ChipMenuItem[];
}

interface ChipMenuItem {
  key: string;
  label: string;
  /** Secondary text, right-aligned and quiet — a kind's capability. */
  detail?: string;
  /** Status of THIS entry (`current`, `needs newer telo`), which is a different
   *  thing from `detail` and is allowed to shout. */
  note?: string;
  noteTone?: "muted" | "warn";
  title?: string;
  /** A row that reports rather than offers: loading, an error, or the reason a
   *  list is empty. Rendered as unselectable prose. */
  message?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

function Chip({
  chip,
  active,
  onOpen,
  openTitle,
  onRename,
  onRemove,
  menus,
  actions,
  alert,
  badge,
}: {
  chip: DeclarationChip;
  active?: boolean;
  onOpen?: () => void;
  openTitle?: string;
  /** Editing the KEY. Separate from the panel's form, which edits the entry's
   *  fields: the key is the entry's identity and the form's own pointer, so it
   *  cannot be one of the fields the form rewrites. */
  onRename?: { validate: (next: string) => string | undefined; commit: (next: string) => void };
  onRemove?: () => void;
  menus?: ChipMenu[];
  /** Extra affordances in the cluster — things the row can do that are neither
   *  opening its entry nor editing its key. */
  actions?: ChipAction[];
  /** A short classifier rendered beside the name — one word about what the row
   *  IS, as opposed to `chip.detail`, which is a second line of its value. */
  badge?: string;
  /** Holds the cluster open. For a row whose actions are not merely available
   *  but WANTED — an outdated import — where hiding them behind hover would
   *  leave the call to action on a rail nobody thinks to hover. */
  alert?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const error = draft === null ? undefined : onRename?.validate(draft);

  if (draft !== null && onRename) {
    return (
      <RenameInput
        draft={draft}
        error={error}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onCommit={() => {
          if (error) return;
          if (draft !== chip.name) onRename.commit(draft);
          setDraft(null);
        }}
      />
    );
  }

  const startRename = onRename ? () => setDraft(chip.name) : undefined;

  return (
    // The row carries the background, not the label — which is what lets the
    // action cluster float over its right edge on a solid lane instead of
    // standing in the flow. Sitting in the flow, those buttons held their width
    // permanently for affordances that are invisible until hover: ~32px of a
    // 208px row, so every label truncated that much earlier, always. Removing
    // them from the flow instead (`hidden`/`flex`) would reflow and re-truncate
    // the label the instant the pointer arrives, which is worse than the gap.
    <div
      className={`group relative flex items-center rounded ${
        active
          ? "bg-indigo-50 dark:bg-indigo-950"
          : onOpen
            ? "hover:bg-zinc-100 dark:hover:bg-zinc-900"
            : ""
      }`}
      // F2 on the focused row, the shortcut every file explorer uses. Bound on
      // the row rather than the label so it fires wherever focus sits within
      // the chip — the label, the pencil, the remove button.
      onKeyDown={(e) => {
        if (e.key !== "F2" || !startRename) return;
        e.preventDefault();
        startRename();
      }}
    >
      <button
        className="min-w-0 flex-1 select-none px-1.5 py-0.5 text-left"
        onClick={onOpen}
        // Double-click renames, the other half of the same convention. The
        // single click that precedes it has already opened the entry, which is
        // what you want open behind a rename anyway.
        onDoubleClick={startRename}
        // Renaming needs the row focusable even where opening it does nothing,
        // so the button stays enabled and the click handler is simply absent.
        title={openTitle ?? chip.detail ?? chip.name}
      >
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-700 dark:text-zinc-200">
            {chip.name}
          </span>
          {badge && (
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {badge}
            </span>
          )}
        </span>
        {chip.detail && (
          <span className="block truncate font-mono text-[9px] text-zinc-400">{chip.detail}</span>
        )}
      </button>
      {/* `bg-inherit` takes the row's own background, so the cluster is only
          ever painted over a solid colour — it is revealed by hover and by
          focus, which are exactly the states in which the row has one.
          `pointer-coarse` has no hover at all, so there it stays visible. */}
      <div
        className={`absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r bg-inherit pl-3 pr-0.5 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100 ${
          alert ? "opacity-100" : "opacity-0"
        }`}
      >
        {(menus ?? []).map((menu) => (
          <DropdownMenu key={menu.key} onOpenChange={menu.onOpenChange}>
            <DropdownMenuTrigger asChild>
              <button className={`${ACTION_CLASS} ${ACTION_TONE.default}`} title={menu.title}>
                {menu.icon}
              </button>
            </DropdownMenuTrigger>
            {/* Beside the row, not below it: the rail is narrow and a list of
                kinds — or of versions — is wider than it. */}
            <DropdownMenuContent
              side="right"
              align="start"
              // Sized to its own content: the shared default matches the trigger's
              // width, and this trigger is one icon.
              className="max-h-72 w-auto min-w-44 overflow-y-auto"
            >
              {menu.label && <DropdownMenuLabel>{menu.label}</DropdownMenuLabel>}
              {menu.items.map((item) => (
                <DropdownMenuItem
                  key={item.key}
                  className={
                    item.message
                      ? "whitespace-normal text-[11px] leading-snug"
                      : "justify-between gap-3 text-xs"
                  }
                  disabled={item.disabled ?? item.message}
                  title={item.title}
                  onSelect={item.onSelect}
                >
                  <span className={item.message ? undefined : "flex-1"}>{item.label}</span>
                  {item.detail && (
                    <span className="ml-3 text-[9px] uppercase tracking-wide text-zinc-400">
                      {item.detail}
                    </span>
                  )}
                  {item.note && (
                    <span
                      className={`ml-3 text-[10px] ${
                        item.noteTone === "warn"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {item.note}
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
        {(actions ?? []).map((item) => (
          <button
            key={item.key}
            className={`${ACTION_CLASS} ${ACTION_TONE[item.tone ?? "default"]}`}
            onClick={item.onClick}
            title={item.title}
          >
            {item.icon}
          </button>
        ))}
        {onRename && (
          <button
            className={`${ACTION_CLASS} ${ACTION_TONE.default}`}
            onClick={() => setDraft(chip.name)}
            title={`Rename ${chip.name}`}
          >
            <Pencil className="size-3.5" />
          </button>
        )}
        {onRemove && (
          <button
            className={`${ACTION_CLASS} ${ACTION_TONE.danger}`}
            onClick={onRemove}
            title={`Remove ${chip.name}`}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** The key, in place. Enter commits, Escape abandons, and losing focus commits
 *  too — a rename left half-typed and clicked away from is far likelier to be
 *  finished than abandoned. A rejected name never commits: the input stays open
 *  with the reason, since the alternative is writing a name `telo check` refuses
 *  or silently overwriting the entry it collides with. */
function RenameInput({
  draft,
  error,
  onChange,
  onCancel,
  onCommit,
}: {
  draft: string;
  error?: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <div className="flex flex-col gap-0.5 px-1.5 py-0.5">
      <input
        ref={ref}
        className={`w-full rounded border bg-white px-1 py-0.5 text-xs outline-none dark:bg-zinc-900 ${
          error
            ? "border-red-400 text-red-600 dark:text-red-400"
            : "border-indigo-400 text-zinc-800 dark:text-zinc-100"
        }`}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => (error ? onCancel() : onCommit())}
      />
      {error && <span className="text-[9px] leading-tight text-red-500">{error}</span>}
    </div>
  );
}
