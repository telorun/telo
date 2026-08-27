import { Button } from "../../components/ui/button";
import type { MissingConfigEntry } from "../context";

interface Props {
  entries: MissingConfigEntry[];
  /** Opens the Run tab, where these values are filled in. */
  onOpenConfig: () => void;
  onDismiss: () => void;
}

/** Pre-flight refusal: the Application declares required variables/secrets with
 *  no default and no value in the active environment, so the kernel would reject
 *  the manifest at boot. Rendered in the dock — the same place the run's output
 *  would have gone — with the fix one click away in the neighbouring tab. */
export function MissingConfigNotice({ entries, onOpenConfig, onDismiss }: Props) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 p-6 text-center dark:bg-zinc-900">
      <div className="max-w-md">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Missing required configuration
        </p>
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          This application declares required values with no default. Fill them in before running:
        </p>
        <ul className="mt-3 space-y-1 text-left">
          {entries.map((entry) => (
            <li key={entry.envVar} className="flex items-baseline gap-2 text-xs">
              <code className="font-medium text-zinc-900 dark:text-zinc-100">{entry.name}</code>
              <span className="text-zinc-500 dark:text-zinc-400">{entry.envVar}</span>
              <span className="text-zinc-400 dark:text-zinc-500">
                ({entry.secret ? "secret" : "variable"})
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onOpenConfig}>
          Fix in Run tab
        </Button>
        <Button size="sm" variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
