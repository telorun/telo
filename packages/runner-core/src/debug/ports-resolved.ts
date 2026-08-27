import { isEventFrame, type DebugFrame } from "@telorun/debug-wire";

import type { PortMapping, PortProtocol } from "../contract.js";

/** The kernel says this once per load: the Application's `ports:` block has
 *  resolved to these integers. It re-fires on every watch reload, which is what
 *  lets a host re-route without parsing a manifest. */
export const PORTS_RESOLVED_EVENT = "Kernel.PortsResolved";

/**
 * The declared port set carried by a `Kernel.PortsResolved` frame, or undefined
 * for any other frame.
 *
 * DECLARED, not bound. A runner routes what the manifest asked for; whether
 * anything actually bound it is the reachability watcher's question, and it
 * already answers it per port. Routing what happened to be bound instead would
 * expose a port the manifest never declared, and would rest on a per-module
 * convention — a transport whose kind does not emit a listening event would
 * silently get no routing at all.
 *
 * Tolerant of a payload that is not the expected shape: a runner reads this off
 * a stream produced by a kernel it does not version together with, so a frame it
 * cannot make sense of is one to ignore, not to fail on.
 */
export function portsResolvedFrom(frame: DebugFrame): PortMapping[] | undefined {
  if (!isEventFrame(frame) || frame.event !== PORTS_RESOLVED_EVENT) return undefined;
  const raw = (frame.payload as { ports?: unknown } | undefined)?.ports;
  if (!Array.isArray(raw)) return undefined;
  const ports: PortMapping[] = [];
  for (const entry of raw) {
    const port = (entry as { port?: unknown })?.port;
    const protocol = (entry as { protocol?: unknown })?.protocol;
    if (typeof port !== "number" || !Number.isInteger(port)) continue;
    ports.push({ port, protocol: protocol === "udp" ? "udp" : ("tcp" as PortProtocol) });
  }
  return ports;
}

/** Identity of a port within a session: the pair, since tcp/3000 and udp/3000
 *  are different endpoints. */
export function portKey(mapping: PortMapping): string {
  return `${mapping.protocol}/${mapping.port}`;
}
