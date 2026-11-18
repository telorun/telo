import {
  DESKTOP_HOST_TYPE,
  PUBLIC_URL_SECONDARY_TEMPLATE_ENV,
  PUBLIC_URL_TEMPLATE_ENV,
  type NeedEnvironmentEntry,
} from "@telorun/analyzer";
import type { Share, SharesFeature } from "@telorun/runner-protocol";
import type { ShareTunnel, ShareTunnelEnding, ShareTunnelEvent, SharePort } from "@telorun/share-tunnel";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadNeedTable } from "../load-need-table.js";
import type { Logger } from "../logger.js";
import { outErrLine } from "../output.js";
import { signInCommand, type CliServices, type StartShareTunnel } from "./cli-services.js";
import { createShare, readSharesFeature, type RunnerClientOptions } from "./runner-client.js";
import { offeringSignIn, type SignInOffer } from "../sign-in/sign-in-offer.js";
import { SignInError } from "../sign-in/sign-in-error.js";
import { resolveRunnerUrl } from "./share-runner-url.js";
import { refusalOfSignIn, ShareRefusal } from "./share-refusal.js";
import { shareNameFor } from "./share-names.js";

/** What a booted kernel tells the share about the ports it resolved. */
export interface SharedKernel {
  getResolvedPorts(): ReadonlyArray<{
    name: string;
    port: number;
    protocol: "tcp" | "udp";
    publicUrls?: Array<{ need: string; host: string }>;
  }>;
  readonly needTable?: { environment: readonly NeedEnvironmentEntry[] };
}

export interface ShareOptions {
  /** The manifest as the command was handed it. */
  manifest: string;
  /** `--share`'s value: empty when it was given bare. */
  name: string;
  /** `--share-runner`. */
  runner: string | undefined;
  env: NodeJS.ProcessEnv;
  services: CliServices;
  log: Logger;
  /** Offers a sign-in when none covers the runner; absent when nobody is at the terminal. */
  offer?: SignInOffer;
}

/**
 * Everything `--share` does before the kernel is built: the refusals that need
 * no network, the runner's capabilities, a credential, the share itself, and the
 * tunnel, which connects in the background. `undefined` when loading the
 * manifest failed (its refusals are already printed and `process.exitCode` set).
 * Throws a {@link ShareRefusal} for every refusal of its own.
 */
export async function prepareShare(options: ShareOptions): Promise<ShareSession | undefined> {
  const { env } = options;
  for (const name of [PUBLIC_URL_TEMPLATE_ENV, PUBLIC_URL_SECONDARY_TEMPLATE_ENV]) {
    if (env[name] !== undefined && env[name] !== "") {
      throw new ShareRefusal(
        "ERR_SHARE_HOST_VALUE_CONFLICT",
        `${name} is set; --share is the host of this run's public addresses`,
      );
    }
  }

  const loaded = await loadNeedTable(options.manifest, options.log, "share");
  if (!loaded) return undefined;
  const application = String(loaded.root.metadata?.name ?? "");
  if (loaded.table.entries.some((entry) => entry.need.type === DESKTOP_HOST_TYPE)) {
    throw new ShareRefusal(
      "ERR_SHARE_APP_UNSUPPORTED",
      `${application} declares Telo.DesktopHost, whose window admission answers every visitor 403`,
    );
  }
  const ports = (loaded.root.ports ?? {}) as Record<string, { protocol?: string } | null>;
  if (!Object.values(ports).some((port) => port?.protocol !== "udp")) {
    throw new ShareRefusal("ERR_SHARE_APP_UNSUPPORTED", `${application} declares no tcp port`);
  }

  const runnerUrl = resolveRunnerUrl(options.runner, env);
  const client: RunnerClientOptions = {
    runnerUrl,
    issuer: options.services.signIn.issuer,
    credentials: offeringSignIn(options.services.credentials, options.services.signIn, options.offer),
  };
  const limits = await readSharesFeature(client);
  const name = options.name !== "" ? options.name : await shareNameFor(manifestKey(options.manifest), env);
  let share: Share;
  try {
    share = await createShare(client, { name, application });
  } catch (error) {
    throw error instanceof SignInError ? refusalOfSignIn(error) : error;
  }
  const startTunnel = await options.services.loadTunnel();
  return new ShareSession(share, runnerUrl, limits, { credentials: options.services.credentials, startTunnel }, { ...env });
}

/** A manifest's identity for the name store: its real path, else what was given
 *  (a URL, or a path that cannot be resolved, which the load refuses anyway). */
function manifestKey(manifest: string): string {
  if (/^https?:\/\//i.test(manifest)) return manifest;
  try {
    const real = fs.realpathSync(path.resolve(manifest));
    return fs.statSync(real).isDirectory() ? path.join(real, "telo.yaml") : real;
  } catch {
    return path.resolve(manifest);
  }
}

/** One `telo run --share`: the share it holds and its tunnel. */
export class ShareSession {
  private readonly tunnel: ShareTunnel;
  private readonly failureHandlers: Array<(refusal: ShareRefusal) => void> = [];
  private failure: ShareRefusal | undefined;
  private announced = false;
  private readonly shared = new Set<string>();
  private readonly forwardWarned = new Map<number, Set<string>>();

  constructor(
    readonly share: Share,
    readonly runnerUrl: string,
    private readonly limits: SharesFeature,
    services: Pick<CliServices, "credentials"> & { startTunnel: StartShareTunnel },
    /** The environment as it was before the kernel hid the variables its needs bind. */
    private readonly env: NodeJS.ProcessEnv = {},
  ) {
    this.tunnel = services.startTunnel({
      tunnelUrl: share.tunnelUrl,
      runnerUrl,
      credentials: services.credentials,
      onEvent: (event) => this.onEvent(event),
    });
    this.tunnel.ended.then(
      (ending) => this.ended(ending),
      (error: unknown) =>
        this.fail(new ShareRefusal(undefined, `the runner credential provider failed: ${error instanceof Error ? error.message : String(error)}`)),
    );
  }

  /** The host values the kernel answers every `Telo.PublicUrl` from, as the
   *  runner worded them. */
  hostValues(): Record<string, string> {
    return {
      [PUBLIC_URL_TEMPLATE_ENV]: this.share.publicUrlTemplate,
      [PUBLIC_URL_SECONDARY_TEMPLATE_ENV]: this.share.publicUrlSecondaryTemplate,
    };
  }

  /** The refusal that ended the share, once it has. */
  get lost(): ShareRefusal | undefined {
    return this.failure;
  }

  /** Called once, when the tunnel ends for a reason that ends the run. */
  onFailure(handler: (refusal: ShareRefusal) => void): void {
    if (this.failure) handler(this.failure);
    else this.failureHandlers.push(handler);
  }

  /** After a successful load: tell the relay the `tcp` ports, and print what is
   *  shared — the whole table the first time, the ports a reload added after. */
  loaded(kernel: SharedKernel): void {
    const resolved = kernel.getResolvedPorts();
    const tcp = resolved.filter((port) => port.protocol === "tcp");
    this.tunnel.setPorts(tcp.map<SharePort>(({ name, port }) => ({ name, port })));
    if (!this.announced) {
      this.announced = true;
      outErrLine(`Shared through ${this.runnerUrl} (share ${this.share.id}):`);
      for (const line of this.table(kernel, resolved)) outErrLine(line);
      for (const port of tcp) this.shared.add(portKey(port));
      return;
    }
    const added = resolved.filter((port) => port.protocol === "tcp" && !this.shared.has(portKey(port)));
    for (const port of tcp) this.shared.add(portKey(port));
    if (added.length === 0) return;
    outErrLine("Reloaded: now also sharing");
    for (const line of this.table(kernel, added)) outErrLine(line);
  }

  async close(): Promise<void> {
    await this.tunnel.close();
  }

  private table(kernel: SharedKernel, ports: ReturnType<SharedKernel["getResolvedPorts"]>): string[] {
    const template = this.share.publicUrlTemplate;
    const scheme = new URL(template.replaceAll("{port}", "0")).protocol;
    const envNameOf = new Map<string, string>();
    for (const entry of kernel.needTable?.environment ?? []) {
      const variable = entry.fields.url?.env;
      if (variable !== undefined) envNameOf.set(entry.path.join("."), variable);
    }
    const rows: string[][] = [];
    const outside: string[][] = [];
    for (const port of ports) {
      if (port.protocol === "udp") {
        rows.push([port.name, `${port.port}/udp`, "not shared: udp"]);
        continue;
      }
      const own = template.replaceAll("{port}", String(port.port));
      const ownHost = new URL(own).host;
      const names: string[] = [];
      for (const need of port.publicUrls ?? []) {
        const variable = envNameOf.get(need.need);
        const given = variable === undefined ? undefined : this.env[variable];
        if (variable !== undefined && given !== undefined && given !== "") {
          outside.push([need.need, "", given, `not shared: set by ${variable}`]);
        } else if (need.host === ownHost) {
          names.push(need.need);
        } else {
          outside.push([need.need, "", `${scheme}//${need.host}`, ""]);
        }
      }
      rows.push([port.name, String(port.port), own, names.join(", ")]);
    }
    return alignRows([...rows, ...outside]);
  }

  private onEvent(event: ShareTunnelEvent): void {
    if (event.type === "forward-failed") {
      const seen = this.forwardWarned.get(event.port) ?? new Set<string>();
      this.forwardWarned.set(event.port, seen);
      if (!seen.has(event.message)) {
        seen.add(event.message);
        outErrLine(`warning: share ${this.share.id}: port ${event.port}: ${event.message}`);
      }
      return;
    }
    if (event.type === "forward-recovered") {
      this.forwardWarned.delete(event.port);
      return;
    }
    if (event.type === "warning") {
      for (const line of this.warning(event)) outErrLine(line);
      return;
    }
    if (event.type === "connected" ? event.reconnect && event.afterWarning : event.afterWarning) {
      outErrLine(`Share ${this.share.id} reconnected.`);
    }
  }

  private warning(event: Extract<ShareTunnelEvent, { type: "warning" }>): string[] {
    const url = this.runnerUrl;
    const retry = "retrying (visitors get 503 meanwhile)";
    const relay = event.detail !== "" ? ` — relay says: ${event.detail}` : "";
    switch (event.reason) {
      case "credential-refused":
        return [`warning: ${url} refused the share's credential; visitors get 503 until you run:`, `  ${signInCommand(url, this.env)}`];
      case "sign-in-required":
        return [`warning: ${url} needs a sign-in; visitors get 503 until you run:`, `  ${event.command ?? signInCommand(url, this.env)}`];
      case "credential-unavailable":
        return [`warning: no credential for ${url}: ${event.detail}; ${retry}`];
      case "owner-limit":
        return [`warning: you already have ${this.limits.maxConnectedPerOwner} shares connected on ${url}; ${retry}${relay}`];
      case "runner-capacity":
        return [`warning: ${url} is at its connected-share capacity; ${retry}${relay}`];
      case "timed-out":
        return [`warning: the tunnel to ${url} timed out; ${retry}${relay}`];
      case "unreachable":
        return [`warning: ${url} could not be reached for the tunnel${event.detail !== "" ? ` (${event.detail})` : ""}; ${retry}`];
      case "disconnected":
        return [`warning: ${url} closed the tunnel${event.code === undefined ? "" : ` (${event.code})`}; ${retry}${relay}`];
    }
  }

  private ended(ending: ShareTunnelEnding): void {
    if (ending.outcome === "closed") return;
    if (ending.outcome === "lost") {
      const why = ending.reason === "superseded" ? "was taken over by another run" : "was deleted";
      this.fail(new ShareRefusal("ERR_SHARE_LOST", `share ${this.share.id} ${why}`));
      return;
    }
    if (ending.cause === "protocol-error") {
      this.fail(
        new ShareRefusal(
          "ERR_SHARE_RUNNER_UNSUPPORTED",
          `the tunnel to ${this.runnerUrl} ended on a protocol error`,
          ending.detail !== "" ? [ending.detail] : [],
        ),
      );
      return;
    }
    this.fail(
      new ShareRefusal(
        "ERR_SHARE_RUNNER_UNSUPPORTED",
        `${this.runnerUrl} speaks no tunnel generation this telo offers (${ending.offered.join(", ")})`,
      ),
    );
  }

  private fail(refusal: ShareRefusal): void {
    if (this.failure) return;
    this.failure = refusal;
    for (const handler of this.failureHandlers.splice(0)) handler(refusal);
  }
}

const portKey = (port: { name: string; port: number }): string => `${port.name}:${port.port}`;

/** Rows of cells, each column padded to its widest cell and two spaces between,
 *  the last cell of a row left as it is; every line indented two spaces. */
export function alignRows(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.slice(0, -1).forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)));
  return rows.map((row) => {
    const cells = row.map((cell, index) => (index < row.length - 1 ? cell.padEnd(widths[index]! + 2) : cell));
    return `  ${cells.join("")}`.trimEnd();
  });
}
