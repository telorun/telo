import * as fs from "fs";
import * as path from "path";
import type { Argv } from "yargs";
import { createLogger, type Logger } from "../logger.js";

async function publishOne(filePath: string, registry: string, log: Logger): Promise<boolean> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    console.error(log.error("error") + `  Cannot read file: ${filePath}`);
    return false;
  }

  // Parse first YAML document to extract metadata
  const firstDoc =
    content.split(/^---$/m)[0].trim() || content.split(/^---\n/m)[1]?.trim() || content;

  const nsMatch = firstDoc.match(/^\s{2,4}namespace:\s*["']?([^\s"']+)["']?/m);
  const nameMatch = firstDoc.match(/^\s{2,4}name:\s*["']?([^\s"']+)["']?/m);
  const versionMatch = firstDoc.match(/^\s{2,4}version:\s*["']?([^\s"']+)["']?/m);

  const namespace = nsMatch?.[1];
  const name = nameMatch?.[1];
  const version = versionMatch?.[1];

  if (!namespace || !name || !version) {
    console.error(
      log.error("error") +
        `  ${filePath}: metadata must include namespace, name, and version.\n` +
        `  Found: namespace=${namespace ?? "(missing)"}, name=${name ?? "(missing)"}, version=${version ?? "(missing)"}`,
    );
    return false;
  }

  const url = `${registry.replace(/\/$/, "")}/${namespace}/${name}/${version}`;
  console.log(log.dim(`Publishing ${namespace}/${name}@${version} → ${url}`));

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "text/yaml" },
      body: content,
    });
  } catch (err) {
    console.error(
      log.error("error") + `  Network error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  let body: unknown;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await res.json();
  } else {
    body = await res.text();
  }

  if (!res.ok) {
    console.error(log.error("error") + `  Publish failed (${res.status}): ${JSON.stringify(body)}`);
    return false;
  }

  const published = (body as any)?.published ?? `${namespace}/${name}@${version}`;
  console.log(log.ok("✓") + `  Published: ${published}`);
  return true;
}

export async function publish(argv: { paths: string[]; registry: string }): Promise<void> {
  const log = createLogger(false);
  let failed = false;
  for (const p of argv.paths) {
    const filePath = path.resolve(process.cwd(), p);
    const ok = await publishOne(filePath, argv.registry, log);
    if (!ok) failed = true;
  }
  if (failed) process.exit(1);
}

export function publishCommand(yargs: Argv): Argv {
  return yargs.command(
    "publish <paths..>",
    "Publish one or more module manifests to the Telo registry",
    (y) =>
      y
        .positional("paths", {
          describe: "Paths to module.yaml files to publish",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("registry", {
          type: "string",
          default: "https://registry.telo.run",
          describe: "Registry base URL",
        }),
    async (argv) => {
      await publish(argv as any);
    },
  );
}
