import { Button } from "../../components/ui/button";

interface Props {
  /** The module whose manifest names the file, relative to the workspace root. */
  importer: string;
  /** What that manifest wrote. */
  source: string;
  /** Where it resolves, outside the opened folder. */
  target: string;
  onDismiss: () => void;
}

/** Pre-flight refusal: the run needs a file from outside the opened folder,
 *  and a session holds the opened folder's tree and nothing above it. */
export function OutsideWorkspaceNotice({ importer, source, target, onDismiss }: Props) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 p-6 text-center dark:bg-zinc-900">
      <div className="max-w-lg">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          This application needs a file outside the workspace
        </p>
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          <code className="font-medium text-zinc-900 dark:text-zinc-100">{importer}</code> imports{" "}
          <code className="font-medium text-zinc-900 dark:text-zinc-100">{source}</code>, which is{" "}
          <code className="break-all">{target}</code>. A run's session holds only the opened folder, so
          open the folder that contains both, or move the module into this one.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
