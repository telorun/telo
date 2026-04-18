import { parseRegistryRef } from "../../loader";
import type { ParsedImport } from "../../model";
import { Button } from "../ui/button";
import { rowBase, rowHover } from "./primitives";
import type { ImportUpgradeState } from "./useImportUpgrade";

function importIcon(kind: ParsedImport["importKind"]): string {
  if (kind === "local") return "⊟";
  if (kind === "registry") return "◆";
  return "↗";
}

interface ImportRowProps {
  imp: ParsedImport;
  upgrade: ImportUpgradeState;
  onRemove: (name: string) => void;
}

export function ImportRow({ imp, upgrade, onRemove }: ImportRowProps) {
  const ref = imp.importKind === "registry" ? parseRegistryRef(imp.source) : null;
  const isUpgrading = upgrade.upgradingName === imp.name;

  return (
    <div className="relative" data-upgrade-dropdown={isUpgrading || undefined}>
      <div className={`group ${rowBase} ${rowHover} text-zinc-600 dark:text-zinc-400`}>
        <span className="flex size-6 shrink-0 items-center justify-center">
          {ref ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                e.stopPropagation();
                upgrade.toggle(imp);
              }}
              disabled={upgrade.submitting}
              data-upgrade-dropdown
              title={`Upgrade ${imp.name} (${ref.version})`}
            >
              ↑
            </Button>
          ) : (
            <span className="text-zinc-400">{importIcon(imp.importKind)}</span>
          )}
        </span>
        <span className="flex-1 truncate">{imp.name}</span>
        {ref && (
          <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-600">
            {ref.version}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="invisible text-zinc-400 group-hover:visible hover:text-red-500 dark:hover:text-red-400"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(imp.name);
          }}
        >
          ×
        </Button>
      </div>

      {isUpgrading && (
        <div
          data-upgrade-dropdown
          className="absolute left-4 right-2 top-full z-10 mt-0.5 max-h-48 overflow-y-auto rounded border border-zinc-200 bg-white shadow-md dark:border-zinc-700 dark:bg-zinc-900"
        >
          {upgrade.loading && (
            <div className="px-3 py-2 text-xs text-zinc-400">Loading versions…</div>
          )}
          {upgrade.error && (
            <div className="px-3 py-2 text-xs text-red-500 dark:text-red-400">{upgrade.error}</div>
          )}
          {!upgrade.loading &&
            upgrade.versions.map((v) => (
              <button
                key={v.version}
                onMouseDown={(e) => {
                  e.preventDefault();
                  upgrade.selectVersion(imp, v.version);
                }}
                disabled={upgrade.submitting}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
                  ref && v.version === ref.version
                    ? "font-medium text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-600 dark:text-zinc-400"
                }`}
              >
                <span>{v.version}</span>
                {ref && v.version === ref.version && (
                  <span className="text-[10px] text-zinc-400">current</span>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
