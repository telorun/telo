/**
 * Which package manager packs an npm anchor: the `packageManager` field of the
 * nearest `package.json` at or above it (never past the workspace), else the one
 * lockfile found nearest it. Two lockfiles of different managers in one
 * directory is an error, never a guess.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn-classic" | "yarn-berry" | "bun";

const LOCKFILES: readonly [string, PackageManager | "yarn"][] = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

export function detectPackageManager(anchorDir: string, root: string): PackageManager {
  for (let dir = anchorDir; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const field = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { packageManager?: unknown }).packageManager;
      if (typeof field === "string") return fromField(field, manifest);
    }
    if (dir === root || path.dirname(dir) === dir) break;
  }
  for (let dir = anchorDir; ; dir = path.dirname(dir)) {
    const found = LOCKFILES.filter(([name]) => fs.existsSync(path.join(dir, name)));
    const managers = [...new Set(found.map(([, manager]) => manager))];
    if (managers.length > 1) {
      throw new Error(
        `${dir} holds lockfiles of ${managers.join(" and ")} (${found.map(([name]) => name).join(", ")}), ` +
          `so which one packs '${anchorDir}' cannot be decided. Remove one, or name the manager in ` +
          `package.json's 'packageManager'.`,
      );
    }
    if (managers.length === 1) {
      const manager = managers[0]!;
      if (manager !== "yarn") return manager;
      return /^__metadata:/m.test(fs.readFileSync(path.join(dir, "yarn.lock"), "utf8")) ? "yarn-berry" : "yarn-classic";
    }
    if (dir === root || path.dirname(dir) === dir) break;
  }
  throw new Error(
    `No package manager is named for '${anchorDir}': no 'packageManager' in a package.json at or ` +
      `above it and no lockfile. Name one in package.json's 'packageManager' (e.g. "pnpm@9.0.0").`,
  );
}

function fromField(field: string, where: string): PackageManager {
  const [name, version = ""] = field.split("@");
  if (name === "npm" || name === "pnpm" || name === "bun") return name;
  if (name === "yarn") return /^1\./.test(version) ? "yarn-classic" : "yarn-berry";
  throw new Error(`${where}: packageManager '${field}' names no manager this adapter drives (npm, pnpm, yarn, bun).`);
}

/** The command packing the package in `cwd` into `destination`. */
export function packCommand(manager: PackageManager, destination: string): { command: string; args: string[] } {
  switch (manager) {
    case "npm":
      return { command: "npm", args: ["pack", "--pack-destination", destination] };
    case "pnpm":
      return { command: "pnpm", args: ["pack", "--pack-destination", destination] };
    case "yarn-classic":
      return { command: "yarn", args: ["pack", "--filename", path.join(destination, "package.tgz")] };
    case "yarn-berry":
      return { command: "yarn", args: ["pack", "--out", path.join(destination, "package.tgz")] };
    case "bun":
      return { command: "bun", args: ["pm", "pack", "--destination", destination] };
  }
}

/** Managers with no workspace protocol: a sibling is named by a plain range. */
export function usesPlainRanges(manager: PackageManager): boolean {
  return manager === "npm" || manager === "yarn-classic";
}
