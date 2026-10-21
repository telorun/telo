import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Prints its text and the directory this file was loaded from.
export const say = {
  async create(resource) {
    return {
      async run() {
        process.stdout.write(`${resource.text} from ${dirname(fileURLToPath(import.meta.url))}\n`);
      },
    };
  },
};
