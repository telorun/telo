import type { DeploymentEnvironment, ParsedManifest } from "../../../model";
import { DeclaredEnvEditor } from "./DeclaredEnvEditor";
import { extractDeclaredEnvEntries } from "./declared-env";
import { extractDeclaredPorts } from "./declared-ports";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { EnvVarsEditor } from "./EnvVarsEditor";
import { PortsEditor } from "./PortsEditor";

export interface RunConfigViewProps {
  manifest: ParsedManifest | null;
  environment: DeploymentEnvironment;
  onSetEnvVars: (env: Record<string, string>) => void;
}

/** The Variables tab: everything that decides what a run gets — the environment, the
 *  Application's declared variables/secrets and ports, and any extra env vars.
 *  Configuration only: the trigger and the status live in the run bar directly
 *  above this view, and the output in the dock below it. */
export function RunConfigView({ manifest, environment, onSetEnvVars }: RunConfigViewProps) {
  const declared = extractDeclaredEnvEntries(manifest);
  const declaredPorts = extractDeclaredPorts(manifest);
  const declaredEnvVarNames = new Set([
    ...declared.map((d) => d.envVar),
    ...declaredPorts.map((p) => p.envVar),
  ]);
  return (
    <div className="flex h-full flex-1 flex-col gap-4 overflow-auto p-4">
      <EnvironmentSelector environment={environment} />
      <DeclaredEnvEditor
        entries={declared}
        value={environment.env}
        onChange={onSetEnvVars}
      />
      <PortsEditor
        entries={declaredPorts}
        value={environment.env}
        onChange={onSetEnvVars}
      />
      <EnvVarsEditor
        value={environment.env}
        onChange={onSetEnvVars}
        declaredEnvVarNames={declaredEnvVarNames}
      />
    </div>
  );
}
