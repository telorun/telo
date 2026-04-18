import type { AvailabilityReport, ProbeConfig } from "../types.js";

export interface ProbeDockerClient {
  ping(): Promise<unknown>;
  getVolume(name: string): { inspect(): Promise<unknown> };
  getNetwork(name: string): { inspect(): Promise<unknown> };
  getImage(name: string): { inspect(): Promise<unknown> };
}

export interface ProbeRunnerContext {
  bundleVolume: string;
  childNetwork: string;
}

export async function runProbe(
  docker: ProbeDockerClient,
  runner: ProbeRunnerContext,
  probe: ProbeConfig,
): Promise<AvailabilityReport> {
  try {
    await docker.ping();
  } catch {
    return {
      status: "unavailable",
      message: "Docker daemon not reachable at /var/run/docker.sock.",
      remediation: "Ensure /var/run/docker.sock is bind-mounted into the runner container and the daemon is running.",
    };
  }

  try {
    await docker.getVolume(runner.bundleVolume).inspect();
  } catch {
    return {
      status: "unavailable",
      message: `Bundle volume '${runner.bundleVolume}' does not exist on the daemon.`,
      remediation: `Run \`docker volume create ${runner.bundleVolume}\` or start the runner with the volume mounted and BUNDLE_VOLUME set to its name.`,
    };
  }

  try {
    await docker.getNetwork(runner.childNetwork).inspect();
  } catch {
    return {
      status: "unavailable",
      message: `Child network '${runner.childNetwork}' does not exist on the daemon.`,
      remediation: `Set RUNNER_CHILD_NETWORK to an existing docker network, or create it with \`docker network create ${runner.childNetwork}\`.`,
    };
  }

  if (probe.pullPolicy !== "always") {
    try {
      await docker.getImage(probe.image).inspect();
    } catch {
      if (probe.pullPolicy === "never") {
        return {
          status: "unavailable",
          message: `Image '${probe.image}' not present locally and pullPolicy is 'never'.`,
          remediation: `Run \`docker pull ${probe.image}\` or change pullPolicy to 'missing' or 'always'.`,
        };
      }
    }
  }

  return { status: "ready" };
}
