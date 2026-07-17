import type { Argv } from "yargs";
import { createLogger, type Logger } from "../logger.js";

const DEFAULT_HUB_URL = "https://telo.sh";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function resolveHubUrl(explicit?: string): string {
  return (explicit ?? process.env.TELO_HUB_URL ?? DEFAULT_HUB_URL).replace(/\/+$/, "");
}

interface KindHit {
  kind: string;
  capability: string;
  description: string;
  module: { ref: string; version: string; description: string };
  score: number;
}

interface ModuleHit {
  module: { ref: string; version: string; description: string };
  score: number;
  matchedKinds: { kind: string; capability: string; description: string; score: number }[];
  exportedKinds: string[];
}

/** `Telo.Invocable` → `Invocable`; abstracts and empty capabilities stay as-is. */
function capabilityLabel(capability: string): string {
  return capability.startsWith("Telo.") ? capability.slice("Telo.".length) : capability;
}

function firstLine(text: string): string {
  return text.split("\n")[0];
}

/** Discovery is a hub verb: search structurally needs the cross-federation
 *  index no single host holds, so this is a thin client of the hub's
 *  `/search/*` endpoints (the `helm search hub` analog). Install/run stay
 *  origin-direct — with the hub down, anything whose ref you hold still works. */
async function fetchSearch(
  hubUrl: string,
  endpoint: "resources" | "modules",
  query: string,
  log: Logger,
): Promise<any> {
  const url = `${hubUrl}/search/${endpoint}?q=${encodeURIComponent(query)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    console.error(
      `${log.error("error")}  could not reach the telo hub at ${hubUrl}: ${errMsg(err)}`,
    );
    console.error(log.dim("Set TELO_HUB_URL or pass --hub-url to use a different hub."));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${log.error("error")}  hub returned ${res.status} ${res.statusText} for ${url}`);
    process.exit(1);
  }
  return res.json();
}

async function runSearch(argv: {
  query: string;
  kinds: boolean;
  hubUrl?: string;
  json: boolean;
}): Promise<void> {
  const log = createLogger(false);
  const hubUrl = resolveHubUrl(argv.hubUrl);
  const body = await fetchSearch(hubUrl, argv.kinds ? "resources" : "modules", argv.query, log);

  if (argv.json) {
    console.log(JSON.stringify(body));
    return;
  }

  if (argv.kinds) {
    const hits = (body.hits ?? []) as KindHit[];
    if (hits.length === 0) {
      console.error(log.dim("no matching resource kinds"));
      return;
    }
    const kindWidth = Math.max(...hits.map((h) => h.kind.length));
    const refWidth = Math.max(...hits.map((h) => `${h.module.ref}@${h.module.version}`.length));
    for (const h of hits) {
      const ref = `${h.module.ref}@${h.module.version}`;
      console.log(
        `${h.kind.padEnd(kindWidth)}  ${ref.padEnd(refWidth)}   ${log.dim(firstLine(h.description))}`,
      );
    }
    return;
  }

  const hits = (body.hits ?? []) as ModuleHit[];
  if (hits.length === 0) {
    console.error(log.dim("no matching modules"));
    return;
  }
  for (const h of hits) {
    console.log(
      `${h.module.ref}@${h.module.version}  —  ${firstLine(h.module.description)}`,
    );
    const kindWidth = Math.max(...h.matchedKinds.map((k) => k.kind.length));
    const capWidth = Math.max(
      ...h.matchedKinds.map((k) => capabilityLabel(k.capability).length + 2),
    );
    for (const k of h.matchedKinds) {
      const cap = `(${capabilityLabel(k.capability)})`;
      console.log(
        `  ${k.kind.padEnd(kindWidth)}  ${log.dim(cap.padEnd(capWidth))}  ${firstLine(k.description)}`,
      );
    }
  }
}

export function searchCommand(yargs: Argv): Argv {
  return yargs.command(
    "search <query>",
    "Search resource kinds across federated modules (needs the telo hub)",
    (y) =>
      y
        .positional("query", {
          describe: "What the resource should do (matched on name and description)",
          type: "string",
          demandOption: true,
        })
        .option("kinds", {
          type: "boolean",
          default: false,
          describe: "Flat kind hits (one line per resource kind) instead of grouped by module",
        })
        .option("hub-url", {
          type: "string",
          describe: "Base URL of the telo hub. Overrides TELO_HUB_URL.",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "Emit the hub response as JSON",
        }),
    async (argv) => {
      await runSearch(argv as any);
    },
  );
}
