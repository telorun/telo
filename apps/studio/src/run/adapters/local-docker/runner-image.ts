import dockerRunnerPackage from "../../../../../docker-runner/package.json";

/** The docker-runner image the supervisor runs. Release builds pin the
 *  docker-runner version built from this same monorepo commit (the publish
 *  workflow tags `telorun/docker-runner:<version>` whenever it moves), so an
 *  editor upgrade recreates the container on the matching runner. Dev builds
 *  track `latest`. */
export const LOCAL_RUNNER_IMAGE = import.meta.env.DEV
  ? "telorun/docker-runner:latest"
  : `telorun/docker-runner:${dockerRunnerPackage.version}`;
