// Rewrites credentials.json in the directory given as argv[2] without end, alternating
// two documents, until killed; prints "writing" once the first write has landed.
import { takeLockFile } from "../../../src/lock-file.js";
import { CredentialsFile, CREDENTIALS_VERSION, type SignInRecord } from "../../../src/sign-in/credentials-file.js";

const file = new CredentialsFile(process.argv[2]!);
const record = (refreshToken: string): SignInRecord => ({
  clientId: "telo-cli",
  dpopKey: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" },
  refreshToken,
  resources: { cloud: "https://cloud.acme.test/api", runner: "https://runner.acme.test" },
  account: { sub: "usr_alice", username: null },
  accessTokens: { "https://runner.acme.test": { token: "t".repeat(1 << 23), expiresAt: new Date(0).toISOString() } },
  signedInAt: new Date(0).toISOString(),
});

let written = 0;
// A killed round leaves its lock behind; the next round takes it over at once.
await file.ensureDirectory();
const lock = await takeLockFile(file.lock, { staleMs: 1, waitMs: 5_000 });
for (;;) {
  const token = written % 2 === 0 ? "even" : "odd";
  await file.write({ version: CREDENTIALS_VERSION, signIns: { "https://accounts.acme.test": record(token) } }, lock);
  if (++written === 1) process.stdout.write("writing\n");
}
