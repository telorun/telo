// The four tasks, the two sides, and what each side is told. The prompts are the only
// instructions an agent gets besides the prose files in its workspace.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "../..");
export const leadIntake = join(repoRoot, "benchmarks/lead-intake");

export const SIDES = ["telo", "node"];

// `contract` is the manifest the contract tests run from: the base run for the build task, the
// base cases plus the task's own for a change task.
export const TASKS = {
  build: { change: false, contract: join(leadIntake, "contract/run.yaml") },
  "add-field": { change: true, directory: join(here, "tasks/add-field"), contract: join(here, "tasks/add-field/contract.yaml") },
  "add-validation-rule": {
    change: true,
    directory: join(here, "tasks/add-validation-rule"),
    contract: join(here, "tasks/add-validation-rule/contract.yaml"),
  },
  "add-endpoint": { change: true, directory: join(here, "tasks/add-endpoint"), contract: join(here, "tasks/add-endpoint/contract.yaml") },
};

const RUNNING = {
  telo: "The entry manifest is `telo.yaml` in this directory: `telo run telo.yaml` starts the service with PORT and STATE_DIR set. Use the installed `telo` CLI and the Telo hub tools to learn the modules you need, and check your manifests with `telo check telo.yaml`.",
  node: "It is a Node.js project (Node 24 and npm are installed): `npm install`, then `npm run build` if the package has a build script, then `npm start` must start the service with PORT and STATE_DIR set.",
};

export function promptFor(task, side) {
  const stack = side === "telo" ? "as a Telo application" : "in Node.js";
  const intro = TASKS[task].change
    ? "This directory holds a working implementation of the service specified in CONTRACT.md. Make the change described in TASK.md, keeping everything else working."
    : `Build the service specified in CONTRACT.md in this directory, ${stack}.`;
  return [
    intro,
    RUNNING[side],
    "Start it yourself and check it against the contract with requests of your own before you finish. Leave the finished service in this directory; you have no other instructions and nobody to ask.",
  ].join("\n\n");
}
