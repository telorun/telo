import { BuildRequest } from "./agent/BuildRequest";
import { DotGridBackdrop } from "./DotGridBackdrop";
import { Button } from "./ui/button";

/** An open workspace holding no module: the starter gallery where the
 *  workspace can be written, then the request for the agent where it is
 *  offered. */
export function EmptyWorkspacePanel({
  onBuild,
  onStartFromStarter,
}: {
  /** Present where the agent is offered: sends the request in this workspace. */
  onBuild?: (request: string) => Promise<boolean>;
  /** Absent while editing is paused. */
  onStartFromStarter?: () => void;
}) {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-5 overflow-y-auto bg-zinc-50 px-6 py-8 text-center dark:bg-zinc-900">
      <DotGridBackdrop />
      <div className="relative flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 md:text-3xl dark:text-zinc-100">
          This workspace has no modules yet
        </h1>
        <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
          Start from a starter — a working app copied into this workspace — or add an Application
          or Library from the sidebar.
        </p>
      </div>
      {onStartFromStarter && (
        <Button className="relative" onClick={onStartFromStarter}>
          Start from a starter
        </Button>
      )}
      {onBuild && (
        <BuildRequest
          onBuild={onBuild}
          subtitle="Describe it and the agent builds it in this workspace."
          sendTitle="Build in this workspace (Enter)"
        />
      )}
    </div>
  );
}
