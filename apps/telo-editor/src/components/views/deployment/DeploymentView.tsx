import type { DeploymentEnvironment, PortMapping } from "../../../model";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { EnvVarsEditor } from "./EnvVarsEditor";
import { PortsEditor } from "./PortsEditor";

export interface DeploymentViewProps {
  environment: DeploymentEnvironment;
  onSetEnvVars: (env: Record<string, string>) => void;
  onSetPorts: (ports: PortMapping[]) => void;
}

export function DeploymentView({
  environment,
  onSetEnvVars,
  onSetPorts,
}: DeploymentViewProps) {
  return (
    <div className="flex h-full flex-1 flex-col gap-4 overflow-auto p-4">
      <EnvironmentSelector environment={environment} />
      <EnvVarsEditor value={environment.env} onChange={onSetEnvVars} />
      <PortsEditor value={environment.ports ?? []} onChange={onSetPorts} />
    </div>
  );
}
