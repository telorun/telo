import { Button } from "../../components/ui/button";
import type { EnvFileProblem } from "../context";

interface Props {
  problems: EnvFileProblem[];
  /** Opens the Variables tab, which reads the same files. */
  onOpenConfig: () => void;
  onDismiss: () => void;
}

/** Pre-flight refusal: the workspace's env files are the run's environment, and
 *  one of them — or the marker that bounds them — could not be read. Each
 *  problem names its file, relative to the workspace root, and the reason. */
export function EnvFilesNotice({ problems, onOpenConfig, onDismiss }: Props) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 p-6 text-center dark:bg-zinc-900">
      <div className="max-w-lg">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          The env files could not be read
        </p>
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          A run takes its variables, secrets and ports from the workspace's env files. Fix these,
          then run again:
        </p>
        <ul className="mt-3 space-y-1.5 text-left">
          {problems.map((problem) => (
            <li key={problem.file} className="text-xs">
              <code className="font-medium text-zinc-900 dark:text-zinc-100">{problem.file}</code>
              <span className="ml-2 break-words text-zinc-600 dark:text-zinc-400">
                {problem.reason}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onOpenConfig}>
          Open Variables tab
        </Button>
        <Button size="sm" variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
