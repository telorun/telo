import type { DeploymentEnvironment } from "../../../model";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { EnvVarsEditor } from "./EnvVarsEditor";

export interface DeploymentViewProps {
  environment: DeploymentEnvironment;
  onSetEnvVars: (env: Record<string, string>) => void;
}

export function DeploymentView({ environment, onSetEnvVars }: DeploymentViewProps) {
  return (
    <div className="flex h-full flex-1 flex-col gap-4 overflow-auto p-4">
      <EnvironmentSelector environment={environment} />
      <EnvVarsEditor value={environment.env} onChange={onSetEnvVars} />
    </div>
  );
}
