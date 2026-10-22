//! How a value type's refusals read. Mirrors the message builders of
//! `../../nodejs/src/value-type-keyword.ts`; the `x-telo-type` validation keyword
//! itself has no Rust counterpart yet.

use telorun_sdk_core::value_type::ValueType;

/// Why a relative path is refused at a host-path slot, after the path.
pub fn host_path_relative_message(entry: &ValueType) -> String {
    let name = &entry.name;
    format!(
        "must be an absolute {name} — a relative path names nothing fixed here. Write a \
         file that ships with the module as !module-path <path>, or read a location on the host \
         from a variable declared x-telo-type: {name}, which resolves a relative value \
         against the working directory"
    )
}
