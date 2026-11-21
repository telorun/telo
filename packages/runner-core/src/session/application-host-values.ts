import { deriveChildSeed, encodeSecretSeed, type SecretSeed } from "@telorun/secret-seed";

export const HOST_STATE_DIR_ENV = "TELO_HOST_STATE_DIR";
export const HOST_SECRET_SEED_ENV = "TELO_HOST_SECRET_SEED";

/**
 * The host values every Run of a session's application receives: its own state directory
 * and its own seed. A set of host values serves exactly one root application, so each
 * application of a session gets a set of its own, derived from the runner's root seed and
 * the application's name in the session (neither part holds `/`). Nothing is stored beside
 * the root: the same inputs give the same seed after a restart, a resume or on a replica.
 */
export class ApplicationHostValues {
  constructor(private readonly rootSeed: SecretSeed | undefined) {}

  /** `env` with any client-supplied value of either host value replaced by the runner's. */
  apply(
    env: Record<string, string>,
    sessionId: string,
    appName: string,
    stateDir: string,
  ): Record<string, string> {
    const rest = { ...env };
    delete rest[HOST_STATE_DIR_ENV];
    delete rest[HOST_SECRET_SEED_ENV];
    return {
      ...rest,
      [HOST_STATE_DIR_ENV]: stateDir,
      ...(this.rootSeed
        ? {
            [HOST_SECRET_SEED_ENV]: encodeSecretSeed(
              deriveChildSeed(this.rootSeed, `telo/secret-seed/${sessionId}/${appName}`),
            ),
          }
        : {}),
    };
  }
}
