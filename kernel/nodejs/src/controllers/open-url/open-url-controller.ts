import {
  PLAIN_ENCODINGS,
  type ResourceContext,
  type ResourceInstance,
  type ResourceManifest,
} from "@telorun/sdk";
import type { ResourceContextImpl } from "../../resource-context.js";

/**
 * `Telo.OpenUrl` — hands a URL to the host to open in a browser.
 *
 * A kernel built-in because opening a page is the host's business, not a
 * module's. Every call logs `telo.url.open_requested` and then forwards the URL
 * to the host's open-url hook, when it gave one. The hook is not awaited: the
 * call returns `null` at once, and a hook that throws or rejects is reported as
 * a warning, never raised — no outcome of opening a page is an error.
 */

/** The text of an input URL, which the contract builds as a `Telo.Url` value. */
function urlText(url: unknown): string {
  return typeof url === "string" ? url : PLAIN_ENCODINGS["url-text"].encode(url);
}

class OpenUrl implements ResourceInstance {
  constructor(private readonly ctx: ResourceContext) {}

  async invoke(inputs: { url: unknown }): Promise<null> {
    const url = urlText(inputs.url);
    this.ctx.log.info(
      "telo.url.open_requested",
      { "url.full": url },
      { eventName: "telo.url.open_requested" },
    );
    const hook = (this.ctx as ResourceContextImpl).openUrlHook;
    if (hook) this.forward(hook, url);
    return null;
  }

  private forward(hook: (url: string) => void | Promise<void>, url: string): void {
    const failed = (error: unknown): void =>
      this.ctx.log.warn(
        "The host could not open the URL",
        { "url.full": url },
        { error: this.ctx.errorValueOf(error) },
      );
    try {
      const pending = hook(url);
      if (pending && typeof (pending as Promise<void>).then === "function") {
        (pending as Promise<void>).then(undefined, failed);
      }
    } catch (error) {
      failed(error);
    }
  }
}

export function register(): void {}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  return new OpenUrl(ctx) as unknown as ResourceInstance;
}
