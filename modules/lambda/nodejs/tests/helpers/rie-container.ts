import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

/** AWS Lambda base images ship with the runtime interface emulator (RIE).
 *  When `$AWS_LAMBDA_RUNTIME_API` is unset (i.e. running locally), the
 *  image's entrypoint starts RIE on port 8080; POSTing a JSON event body to
 *  `/2015-03-31/functions/function/invocations` invokes the handler. */
const RIE_PORT = 8080;

const MANAGED_IMAGE = "public.ecr.aws/lambda/nodejs:24";
/** nodejs image (Node + RIE bundled), not `provided:al2023` (no Node),
 *  because `custom.mjs` is a Node script. */
const CUSTOM_IMAGE = "public.ecr.aws/lambda/nodejs:24";

export interface StartedRie {
  /** RIE invocations endpoint:
   *  `http://localhost:<host-port>/2015-03-31/functions/function/invocations`. */
  invokeUrl: string;
  /** Container stdout/stderr accumulated so far — useful in failure reports. */
  getLogs: () => Promise<string>;
  stop: () => Promise<void>;
}

export interface StartRieOptions {
  /** Absolute path to the fixture dir; bound to `/var/task` inside. */
  fixtureDir: string;
  /** Managed mode pins the handler entry; custom mode runs the bootstrap. */
  mode: "managed" | "custom";
}

/** Starts the AWS Lambda runtime image under testcontainers, bind-mounts the
 *  fixture as `/var/task`, and waits for RIE to come up. */
export async function startRie(options: StartRieOptions): Promise<StartedRie> {
  const image = options.mode === "managed" ? MANAGED_IMAGE : CUSTOM_IMAGE;
  let builder = new GenericContainer(image)
    .withExposedPorts(RIE_PORT)
    // rw mount: the kernel's controller-install loop writes to `.telo/` on
    // cold boot. In prod, `telo install` populates `.telo/` before packaging
    // so the boot-time write never fires; tests don't pre-warm that path.
    .withBindMounts([{ source: options.fixtureDir, target: "/var/task", mode: "rw" }])
    .withWaitStrategy(Wait.forListeningPorts());

  if (options.mode === "managed") {
    builder = builder.withCommand(["index.handler"]);
  } else {
    // Bypass the image's default Node-RIC entrypoint and have RIE invoke our
    // bootstrap directly. RIE sets `$AWS_LAMBDA_RUNTIME_API` for the child,
    // which is what `custom.mjs`'s poll loop expects.
    builder = builder
      .withEntrypoint(["/usr/local/bin/aws-lambda-rie"])
      .withCommand(["node", "/var/task/bootstrap"]);
  }

  const container: StartedTestContainer = await builder.start();
  const host = container.getHost();
  const port = container.getMappedPort(RIE_PORT);

  return {
    invokeUrl: `http://${host}:${port}/2015-03-31/functions/function/invocations`,
    getLogs: async () => (await container.logs()).toString(),
    stop: () => container.stop(),
  };
}

/** POSTs `event` to the RIE invocations endpoint and returns the parsed JSON
 *  response body. An unhandled Lambda throw surfaces as a body with
 *  `errorType` / `errorMessage` / `stackTrace`; tests can assert on either
 *  shape. */
export async function invokeRie(invokeUrl: string, event: unknown): Promise<unknown> {
  const res = await fetch(invokeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`RIE returned HTTP ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`RIE returned non-JSON response: ${text}`);
  }
}
