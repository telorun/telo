import type { DeploymentEnvironment, ParsedManifest, PortMapping } from "../../../model";
import { DeclaredEnvEditor } from "./DeclaredEnvEditor";
import { extractDeclaredEnvEntries } from "./declared-env";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { EnvVarsEditor } from "./EnvVarsEditor";
import { PortsEditor } from "./PortsEditor";

export interface DeploymentViewProps {
  manifest: ParsedManifest | null;
  environment: DeploymentEnvironment;
  onSetEnvVars: (env: Record<string, string>) => void;
  onSetPorts: (ports: PortMapping[]) => void;
}

export function DeploymentView({
  manifest,
  environment,
  onSetEnvVars,
  onSetPorts,
}: DeploymentViewProps) {
  const declared = extractDeclaredEnvEntries(manifest);
  const declaredEnvVarNames = new Set(declared.map((d) => d.envVar));
  return (
    <div className="flex h-full flex-1 flex-col gap-4 overflow-auto p-4">
      <EnvironmentSelector environment={environment} />
      <DeclaredEnvEditor
        entries={declared}
        value={environment.env}
        onChange={onSetEnvVars}
      />
      <EnvVarsEditor
        value={environment.env}
        onChange={onSetEnvVars}
        declaredEnvVarNames={declaredEnvVarNames}
      />
      <PortsEditor value={environment.ports ?? []} onChange={onSetPorts} />
    </div>
  );
}
