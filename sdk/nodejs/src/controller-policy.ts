/**
 * Resolved selection policy describing which controller implementation a
 * `Telo.Import`'s consumers should load. Produced by the kernel from the
 * import's `runtime:` field and stamped on the child module context; read
 * by `Telo.Definition.init` via `ResourceContext.getControllerPolicy()`.
 *
 * `load` is an ordered list of PURL-type prefixes (`pkg:npm`, `pkg:cargo`, …)
 * optionally containing a single wildcard sentinel `"*"` meaning "all
 * remaining declared controllers in declaration order, minus types listed
 * earlier in this list."
 */
export type ControllerPolicy = {
  readonly load: ReadonlyArray<string>;
};
