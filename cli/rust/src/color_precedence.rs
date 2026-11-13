//! Whether a stream is painted. Twin of the kernel's `logging/color-precedence.ts`
//! (`decideColor`) for the `auto` setting; it lives in the CLI because this kernel has no
//! logging yet, and the CLI is the only reader.
//!
//! `NO_COLOR` counts only when non-empty, `FORCE_COLOR` `0` disables and any other
//! non-empty value enables, `CLICOLOR_FORCE` present and not `0` enables, `CLICOLOR=0`
//! disables, a `dumb` terminal disables, and otherwise the descriptor decides. There is
//! deliberately no CI-variable branch.

use std::collections::HashMap;

pub fn decide_color(env: &HashMap<String, String>, is_tty: bool) -> bool {
    let non_empty = |name: &str| env.get(name).filter(|value| !value.is_empty());
    if non_empty("NO_COLOR").is_some() {
        return false;
    }
    if let Some(force) = non_empty("FORCE_COLOR") {
        return force != "0";
    }
    if env.get("CLICOLOR_FORCE").is_some_and(|value| value != "0") {
        return true;
    }
    if env.get("CLICOLOR").is_some_and(|value| value == "0") {
        return false;
    }
    if env.get("TERM").is_some_and(|value| value == "dumb") {
        return false;
    }
    is_tty
}

/// `CLICOLOR_FORCE` → `FORCE_COLOR`, as the Node CLI's colour bridge does, so a `0`
/// there disables colour here as it does in Node and an existing `FORCE_COLOR` is never
/// overwritten. Mirrors `../../nodejs/src/color-bridge.ts`; called first in `main`,
/// before anything reads the environment or a thread exists.
pub fn bridge_clicolor_force() {
    let Some(force) = std::env::var_os("CLICOLOR_FORCE") else { return };
    if std::env::var_os("FORCE_COLOR").is_none() {
        std::env::set_var("FORCE_COLOR", if force == "0" { "0" } else { "1" });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn follows_the_precedence_order() {
        assert!(!decide_color(&env(&[("NO_COLOR", "1"), ("FORCE_COLOR", "1")]), true));
        assert!(decide_color(&env(&[("NO_COLOR", "")]), true));
        assert!(!decide_color(&env(&[("FORCE_COLOR", "0")]), true));
        assert!(decide_color(&env(&[("FORCE_COLOR", "1")]), false));
        assert!(decide_color(&env(&[("CLICOLOR_FORCE", "1")]), false));
        assert!(!decide_color(&env(&[("CLICOLOR", "0")]), true));
        assert!(!decide_color(&env(&[("TERM", "dumb")]), true));
        assert!(decide_color(&env(&[]), true));
        assert!(!decide_color(&env(&[]), false));
    }
}
