import { WORKSPACE_FILENAME, type WorkspaceEnvResolution } from "@telorun/analyzer";
import { useEffect, useRef, useState } from "react";
import { pathBasename } from "../../../loader/paths";
import type { ViewProps } from "../types";
import { resolveApplicationEnv } from "../../../run/application-env";

export interface ApplicationEnvState {
  resolution: WorkspaceEnvResolution | null;
  /** Why the files could not be resolved at all. */
  error: string | null;
}

/**
 * The Application's env files as the Variables tab shows them: read when the
 * tab opens, and again on a change to a file named by an `env.files` entry in
 * force, to the workspace marker, or to the whole workspace. The run never
 * reads this state — it resolves the files itself when it starts.
 */
export function useApplicationEnv(
  manifestPath: string,
  environment: ViewProps["environment"],
): ApplicationEnvState {
  const [state, setState] = useState<ApplicationEnvState>({ resolution: null, error: null });
  const namesRef = useRef<ReadonlySet<string>>(new Set([WORKSPACE_FILENAME]));
  const { rootDir, adapter, changes } = environment;

  useEffect(() => {
    let current = true;
    let generation = 0;
    const read = () => {
      const workspace = adapter();
      if (!workspace) return;
      const mine = ++generation;
      resolveApplicationEnv(workspace, rootDir, manifestPath).then(
        (resolution) => {
          if (!current || mine !== generation) return;
          namesRef.current = new Set([WORKSPACE_FILENAME, ...resolution.entries.map((entry) => entry.name)]);
          setState({ resolution, error: null });
        },
        (err: unknown) => {
          if (!current || mine !== generation) return;
          setState({ resolution: null, error: err instanceof Error ? err.message : String(err) });
        },
      );
    };
    read();
    const unsubscribe = changes.subscribe((change) => {
      if (change.kind === "workspace" || change.paths.some((path) => namesRef.current.has(pathBasename(path)))) {
        read();
      }
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [adapter, changes, manifestPath, rootDir]);

  return state;
}
