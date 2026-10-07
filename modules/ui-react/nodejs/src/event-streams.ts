import { sseComment, sseFrame } from "@telorun/sse-codec";
import type { EffectHandle, ResourceContext } from "@telorun/sdk";
import type { ServerResponse } from "node:http";

const KEEPALIVE_MS = 25_000;

/** The open event streams of one application. Each is an effect of its own:
 *  performed when the stream opens, disposed when either side ends it. */
export class EventStreams {
  private readonly open = new Set<EffectHandle>();

  constructor(
    private readonly owner: string,
    private readonly ctx: Pick<ResourceContext, "effect" | "log">,
    private readonly keepaliveMs = KEEPALIVE_MS,
  ) {}

  /** Start a stream on `response`: a `hello` naming the renderer the server
   *  holds, then a comment at each keepalive interval until it ends. */
  async start(response: ServerResponse, bundle: string): Promise<void> {
    const handle = await this.ctx
      .effect("ui event stream", async () => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        });
        response.write(sseFrame({ type: "hello", bundle }, this.owner));
        const keepalive = setInterval(
          () => response.write(sseComment("keepalive", this.owner)),
          this.keepaliveMs,
        );
        return {
          result: undefined,
          inverse: () => {
            clearInterval(keepalive);
            response.end();
          },
        };
      })
      .perform();
    this.open.add(handle);
    response.on("close", () => {
      this.open.delete(handle);
      handle.dispose().catch((error: unknown) =>
        this.ctx.log.error("An event stream could not be released when it closed", {
          owner: this.owner,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  /** End every open stream. */
  async closeAll(): Promise<void> {
    const handles = [...this.open];
    this.open.clear();
    await Promise.all(handles.map((handle) => handle.dispose()));
  }
}
