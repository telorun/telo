/**
 * Replays the CEL conformance vectors through `@telorun/cel`.
 *
 * The vectors directory is a parameter of the package's conformance config, and this
 * script is the only thing in the repository that names where the vectors currently live —
 * so moving them is a one-line change here, and `@telorun/cel`'s own test suite never
 * needs a sibling package's tree to exist.
 *
 * It is also where the HOST's type vocabulary is declared, for the same reason. The
 * dialect rows (`types.json`) declare variables of Telo's nominal value types, and the
 * engine knows no host type name by design — a host registers its own through
 * `registerType`. So the types are handed over here, as the engine's own registration
 * shape, and the driver refuses a row declaring a name this list does not carry rather
 * than inventing one. The authority for the list is `sdk/value-types/*.json` (the `base`
 * of each `representation: json` entry, and `fromHost`, which is what may be extended with
 * `joinPath`) plus the live stream type the tag layer registers under the bare name
 * `Stream`.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const vectors = fileURLToPath(new URL("templating/cel-conformance/", root));

const brand = (name, base) => ({
  name,
  base,
  // A brand is not its base, so every conversion it answers is declared: the base's own
  // conversion, and `string()` for rendering it as text.
  conversions: base === "string" ? [`string(Self): string`] : [`${base}(Self): ${base}`, "string(Self): string"],
});

const hostTypes = [
  brand("Telo.TcpPort", "int"),
  brand("Telo.UdpPort", "int"),
  {
    ...brand("Telo.HostPath", "string"),
    // `fromHost` in its value-type entry: a value of it comes from the machine, and
    // extending one keeps it one.
    members: ["Self.joinPath(string): Self"],
  },
  // A live handle: no base conversion, no member, so reading anything of it is refused.
  { name: "Stream", base: "dyn" },
];

const result = spawnSync("pnpm", ["--filter", "@telorun/cel", "run", "test:conformance"], {
  cwd: fileURLToPath(root),
  env: {
    ...process.env,
    CEL_CONFORMANCE_DIR: vectors,
    CEL_CONFORMANCE_HOST_TYPES: JSON.stringify(hostTypes),
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
