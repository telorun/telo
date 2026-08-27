/**
 * `CLICOLOR_FORCE` → `FORCE_COLOR`, for Node's colour libraries only.
 *
 * `CLICOLOR_FORCE` is the convention with the widest native reach — Rust's
 * `anstyle` / `clicolors`, Go's `fatih/color` and BSD-derived tooling all read it
 * unaided, and the kernel's own colour precedence consults it directly. Node is
 * the sole ecosystem whose libraries (`supports-color`, and therefore chalk) read
 * `FORCE_COLOR` and ignore it. So the adapter belongs in the runtime whose
 * libraries fall short, not in the environment that feeds them: an environment
 * that had to name both would grow a list of per-ecosystem spellings, one longer
 * per kernel.
 *
 * Two properties are load-bearing:
 *
 *  - This module must be evaluated BEFORE any library computes a colour level.
 *    ES module imports are hoisted, so a statement placed above one still runs
 *    after it; being a side-effecting module listed first is what makes it
 *    genuinely first. Import it at the top of the CLI entry point and nowhere
 *    else.
 *
 *  - An existing `FORCE_COLOR` is never overwritten. `FORCE_COLOR` outranks
 *    `CLICOLOR_FORCE` in the precedence order precisely so `FORCE_COLOR=0` with
 *    `CLICOLOR_FORCE=1` can mean "off for Node, forced for everything else".
 *    Overwriting would erase a distinction the order exists to make.
 *
 * An empty `CLICOLOR_FORCE` is deliberately treated as present-and-forcing, which
 * is what the precedence order says: only the literal `"0"` disables. That is
 * also why no image bakes the variable — the usual way to override one (an empty
 * value in a pod spec, `-e CLICOLOR_FORCE=`) sets it empty rather than removing
 * it, so a baked default would be undisableable by the normal means.
 */
const clicolorForce = process.env.CLICOLOR_FORCE;
if (clicolorForce !== undefined && process.env.FORCE_COLOR === undefined) {
  process.env.FORCE_COLOR = clicolorForce === "0" ? "0" : "1";
}

export {};
