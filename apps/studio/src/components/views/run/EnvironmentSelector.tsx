import type { DeploymentEnvironment } from "../../../model";

interface EnvironmentSelectorProps {
  environment: DeploymentEnvironment;
}

// v1: single "Local" environment, read-only. A future version turns this into
// a dropdown with add/rename/delete affordances; keeping it a separate file
// so that's an additive change.
export function EnvironmentSelector({ environment }: EnvironmentSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide dark:text-zinc-400">
        Environment
      </span>
      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
        {environment.name}
      </span>
    </div>
  );
}
