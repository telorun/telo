import type { AvailabilityReport, ProbeConfig } from "@telorun/runner-core";
import { validateContainerConfig } from "@telorun/runner-core/container";

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

  // A probe carries the config the client is about to run with, and core no
  // longer knows its shape — so a config this backend cannot use is reported as
  // something to fix rather than probed around.
  const invalid = validateContainerConfig(probe);
  if (invalid) {
    return { status: "needs-setup", issues: [{ path: "/image", message: invalid }] };
  }

  const image = probe.image as string;
  if (probe.pullPolicy !== "always") {
    try {
      await docker.getImage(image).inspect();
    } catch {
      if (probe.pullPolicy === "never") {
        return {
          status: "unavailable",
          message: `Image '${image}' not present locally and pullPolicy is 'never'.`,
          remediation: `Run \`docker pull ${image}\` or change pullPolicy to 'missing' or 'always'.`,
        };
      }
    }
  }

  return { status: "ready" };
}
