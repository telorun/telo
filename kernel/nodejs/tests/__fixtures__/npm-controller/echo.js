// Imports the SDK so installing this package resolves `@telorun/sdk` through the
// install root, which is what the realm tests inspect.
import { Stream } from "@telorun/sdk";

export function register() {}

export async function create(resource) {
  return {
    snapshot() {
      return { name: resource.metadata?.name, stream: typeof Stream };
    },
  };
}
