import type { ResourceInstance } from "@telorun/sdk";
import type { ContainerReadiness, ReadinessTarget } from "./container-engine-contract.js";

interface LogReadyResource {
  metadata: { name: string };
  text: string;
  times?: unknown;
}

/**
 * Container.LogReady — ready once `text` has appeared `times` times in the
 * container's output. Occurrences are counted without overlap, and one may span
 * two chunks: the last `text.length - 1` characters are carried into the next.
 */
export class LogReady implements ContainerReadiness, ResourceInstance {
  private readonly text: string;
  private readonly times: number;

  constructor(resource: LogReadyResource) {
    this.text = resource.text;
    this.times = resource.times === undefined ? 1 : Number(resource.times);
  }

  async waitUntilReady(target: ReadinessTarget, signal: AbortSignal): Promise<boolean> {
    const keep = this.text.length - 1;
    let seen = 0;
    let carry = "";
    for await (const chunk of target.logs(signal)) {
      let window = carry + chunk;
      let at = window.indexOf(this.text);
      while (at !== -1) {
        if (++seen >= this.times) return true;
        window = window.slice(at + this.text.length);
        at = window.indexOf(this.text);
      }
      carry = keep > 0 ? window.slice(-keep) : "";
    }
    return false;
  }

  snapshot(): Record<string, unknown> {
    return { text: this.text, times: this.times };
  }
}

export async function create(resource: LogReadyResource): Promise<LogReady> {
  return new LogReady(resource);
}
