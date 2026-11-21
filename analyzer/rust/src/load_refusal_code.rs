//! The code the load refusal rule raises a static code under — the one mapping from what
//! `telo check` reports to what a kernel raises at load, read by every group of the rule.
//! Mirrors `../../nodejs/src/load-refusal-code.ts`.

/// The static codes a kernel raises under a name of their own.
const RUNTIME_CODE_EXCEPTIONS: [(&str, &str); 3] = [
    ("DUPLICATE_RESOURCE_NAME", "ERR_DUPLICATE_RESOURCE"),
    ("SCHEMA_VIOLATION", "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED"),
    ("UNRESOLVED_REFERENCE", "ERR_REF_UNRESOLVED"),
];

/// The runtime code of the static `code`: its exception, else `ERR_<code>`.
pub fn runtime_code_of(code: &str) -> String {
    RUNTIME_CODE_EXCEPTIONS
        .iter()
        .find(|(static_code, _)| *static_code == code)
        .map_or_else(|| format!("ERR_{code}"), |(_, runtime)| (*runtime).to_string())
}

#[cfg(test)]
mod tests {
    use super::runtime_code_of;

    #[test]
    fn maps_the_exceptions_and_prefixes_every_other_code() {
        assert_eq!(runtime_code_of("DUPLICATE_RESOURCE_NAME"), "ERR_DUPLICATE_RESOURCE");
        assert_eq!(runtime_code_of("SCHEMA_VIOLATION"), "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED");
        assert_eq!(runtime_code_of("UNRESOLVED_REFERENCE"), "ERR_REF_UNRESOLVED");
        assert_eq!(runtime_code_of("METADATA_RESERVED_FIELD"), "ERR_METADATA_RESERVED_FIELD");
    }
}
