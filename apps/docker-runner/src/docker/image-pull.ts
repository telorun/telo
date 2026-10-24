import { SessionStartError, type PullPolicy } from "@telorun/runner-core";

import { messageOf, type SessionDockerClient } from "./docker-api.js";

/** Make `image` present on the daemon under `pullPolicy`, or fail the
 *  session's start naming it. */
export async function ensureImage(
  docker: Pick<SessionDockerClient, "getImage" | "pull" | "modem">,
  image: string,
  pullPolicy: PullPolicy,
): Promise<void> {
  if (pullPolicy !== "always") {
    try {
      await docker.getImage(image).inspect();
      return;
    } catch (err) {
      if (pullPolicy === "never") {
        throw new SessionStartError(
          "pull_failed",
          "inspect",
          `image '${image}' is not present on the daemon and the pull policy is 'never'`,
          messageOf(err),
        );
      }
    }
  }

  let stream: NodeJS.ReadableStream;
  try {
    stream = await docker.pull(image);
  } catch (err) {
    throw new SessionStartError("pull_failed", "pull", `could not start pulling '${image}'`, messageOf(err));
  }
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => {
      if (err) reject(new SessionStartError("pull_failed", "pull", `pulling '${image}' failed`, messageOf(err)));
      else resolve();
    });
  });
}
