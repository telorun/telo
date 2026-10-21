import { execFileSync } from "node:child_process";

// Prints the TELO_APP_CLI this controller sees, and the one a process it starts
// sees.
const seen = "process.stdout.write(process.env.TELO_APP_CLI ?? 'unset')";

export const probe = {
  async create() {
    return {
      async run() {
        const child = execFileSync(process.execPath, ["-e", seen], { encoding: "utf8" });
        process.stdout.write(`controller=${process.env.TELO_APP_CLI ?? "unset"} child=${child}\n`);
      },
    };
  },
};
