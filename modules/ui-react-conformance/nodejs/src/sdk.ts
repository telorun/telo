// Loaded on the main thread only: the bundle is also the check window's entry,
// and a worker has no kernel for the SDK to resolve against.
type Sdk = typeof import("@telorun/sdk");
let sdkModule: Promise<Sdk> | undefined;
export const loadSdk = (): Promise<Sdk> => (sdkModule ??= import("@telorun/sdk"));
