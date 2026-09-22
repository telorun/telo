import type { EngineFileClaim, TemplatingEngine } from "../engine.js";
import { MODULE_PATH_ENGINE, makeTaggedSentinel } from "../sentinel.js";
import { normalizeModulePath } from "./include.js";

/**
 * The `!module-path` engine — a file or directory that ships inside the module,
 * named by its LOCATION: at resource creation the kernel resolves it to the
 * absolute path where the module's files are on disk (a checkout, or the
 * materialized assets layer of a published artifact).
 *
 * The include engines' posture throughout: `compile` is identity on the marker,
 * the path is a literal checked as a pure string, and `fileClaims` hands the
 * path to publish and packaging so neither recognises the tag. A computed path
 * is unrepresentable on purpose — what ships has a name known at publish time.
 *
 * It produces a `Telo.HostPath`: once resolved it is an absolute host path,
 * which is what any slot declaring that type holds.
 */
export const modulePathEngine: TemplatingEngine = {
  name: MODULE_PATH_ENGINE,

  compile(source) {
    return makeTaggedSentinel(MODULE_PATH_ENGINE, source);
  },

  producedType() {
    return { type: "string", "x-telo-type": "Telo.HostPath" };
  },

  analyze(source) {
    const { diagnostic } = normalizeModulePath(source);
    return { diagnostics: diagnostic ? [diagnostic] : [], calls: [] };
  },

  fileClaims(source): readonly EngineFileClaim[] {
    const { path } = normalizeModulePath(source);
    return path ? [{ path, directory: true }] : [];
  },
};
