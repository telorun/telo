import { TriangleAlert } from "lucide-react";
import type { ParsedManifest } from "../../../model";
import { applicationSensitiveInputs, envFileProblems, workspaceFileOf } from "../../../run/application-env";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import type { ViewProps } from "../types";
import { DeclaredEnvEditor } from "./DeclaredEnvEditor";
import { extractDeclaredEnvEntries } from "./declared-env";
import { extractDeclaredPorts } from "./declared-ports";
import { envRowFacts } from "./env-row-facts";
import { PortsEditor } from "./PortsEditor";
import { useApplicationEnv } from "./use-application-env";

export interface RunConfigViewProps {
  manifest: ParsedManifest;
  environment: ViewProps["environment"];
  readOnly: boolean;
}

/** The Variables tab: a view over the workspace's env files — the Application's
 *  declared variables, secrets and ports, each with the value a run would get
 *  and the file it comes from, edited in that file. Variables nothing declares
 *  live in the same files, opened in the code editor. The trigger and status
 *  live in the run bar above this view, the output in the dock below it. */
export function RunConfigView({ manifest, environment, readOnly }: RunConfigViewProps) {
  const declared = extractDeclaredEnvEntries(manifest);
  const declaredPorts = extractDeclaredPorts(manifest);
  const { resolution, error } = useApplicationEnv(manifest.filePath, environment);
  const { rootDir } = environment;
  const facts = envRowFacts({
    resolution,
    rootDir,
    manifestPath: manifest.filePath,
    sensitiveInputs: applicationSensitiveInputs(manifest),
    adapter: environment.adapter,
    readOnly,
  });
  const problems = error
    ? [{ file: workspaceFileOf(rootDir, manifest.filePath), reason: error }]
    : resolution
      ? envFileProblems(resolution, rootDir)
      : [];

  return (
    <div className="flex h-full flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Values come from the workspace's env files, nearest directory first. A value is changed
          in the file it comes from; a new one is added beside this manifest.
        </span>
        {resolution && resolution.files.length > 0 && (
          <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            Read from{" "}
            {resolution.files
              .map((file) => `${workspaceFileOf(rootDir, file.path)}${file.sensitive ? " (sensitive)" : ""}`)
              .join(", ")}
          </span>
        )}
      </div>
      {problems.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>The env files could not be read; a run is refused until they can</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {problems.map((problem) => (
                <li key={problem.file}>
                  <code>{problem.file}</code> {problem.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {resolution || error ? (
        <>
          <DeclaredEnvEditor entries={declared} facts={facts} />
          <PortsEditor entries={declaredPorts} facts={facts} />
        </>
      ) : (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">Reading the env files…</span>
      )}
    </div>
  );
}
