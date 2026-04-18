import Docker from "dockerode";

export type DockerClient = Docker;

export function createDockerClient(): DockerClient {
  return new Docker({ socketPath: "/var/run/docker.sock" });
}
