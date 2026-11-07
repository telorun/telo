//! The catalog's declarations held to its behaviour — the twin of
//! `cel/nodejs/tests/function-catalog.test.ts`, case for case: every signature the data
//! declares has an implementation, every implementation answers a declared signature,
//! every guard the data claims exists, a host-backed call with no handler names the
//! function and answers with one, and a literal argument is refused at check, naming the
//! call as written. Beside them, the listing surface itself, as Node's `functionCatalog()`
//! answers it — `@telorun/cel 0.129.0 at 2ee5ef49` under Node v24.21.0 (V8
//! 13.6.233.17-node.53, ICU 78.3, tz 2026c), executed.

use std::collections::HashSet;
use std::sync::Arc;

use telorun_cel::{
    catalog_categories, catalog_guarded_names, catalog_implementation, catalog_implemented_keys, catalog_signatures,
    function_catalog, parse_signature, register_function_catalog, signature_key, CelCatalogHandlers, CelCheckCode,
    CelEnvironment, CelEnvironmentOptions, CelEvaluateError, CelValue, EvaluateOptions, RegisterCatalogOptions,
    SourceRange, FUNCTION_CATALOG_GENERATION,
};

fn keys_declared() -> Vec<String> {
    catalog_signatures().iter().map(|signature| signature_key(&parse_signature(signature, None).unwrap())).collect()
}

#[test]
fn implements_every_signature_it_declares() {
    let missing: Vec<String> = keys_declared()
        .into_iter()
        .filter(|key| catalog_implementation(key, &CelCatalogHandlers::default()).is_none())
        .collect();
    assert_eq!(missing, Vec::<String>::new());
}

#[test]
fn implements_nothing_it_does_not_declare() {
    let declared: HashSet<String> = keys_declared().into_iter().collect();
    let undeclared: Vec<&str> = catalog_implemented_keys().into_iter().filter(|key| !declared.contains(*key)).collect();
    assert_eq!(undeclared, Vec::<&str>::new());
}

#[test]
fn guards_exactly_the_functions_the_data_says_check_their_literal_arguments() {
    let mut claimed: Vec<&str> =
        function_catalog().iter().filter(|entry| entry.checks_literal_arguments).map(|entry| entry.name.as_str()).collect();
    let mut guarded = catalog_guarded_names();
    claimed.sort_unstable();
    guarded.sort_unstable();
    assert_eq!(guarded, claimed);
}

#[test]
fn answers_a_host_backed_call_with_no_handler_by_naming_the_function() {
    let mut environment = CelEnvironment::default();
    register_function_catalog(&mut environment, RegisterCatalogOptions::default());
    match environment.evaluate("sha256('abc')", &(), &EvaluateOptions::default()) {
        Err(CelEvaluateError::Evaluation(error)) => assert_eq!(
            (error.code.as_str(), error.message.as_str(), error.range),
            (
                "unbound_function",
                "sha256() is supplied by the host, and this environment was given no implementation for it",
                Some(SourceRange { start: 0, end: 13 })
            )
        ),
        other => panic!("sha256 with no handler answered {other:?}"),
    }
    let mut supplied = CelEnvironment::default();
    let handlers = CelCatalogHandlers { sha256: Some(Arc::new(|text| Ok(format!("hashed:{text}")))), ..Default::default() };
    register_function_catalog(&mut supplied, RegisterCatalogOptions { handlers });
    assert_eq!(
        supplied.evaluate("sha256('abc')", &(), &EvaluateOptions::default()).unwrap(),
        CelValue::String("hashed:abc".into())
    );
}

#[test]
fn refuses_an_argument_written_as_a_literal_at_check_naming_the_call_as_written() {
    let mut environment = CelEnvironment::new(CelEnvironmentOptions { unlisted_variables_are_dyn: true, ..Default::default() });
    register_function_catalog(&mut environment, RegisterCatalogOptions::default());
    let refused = environment.check("1 + size(fixed(1.0, 11))");
    let found: Vec<(CelCheckCode, &str, SourceRange)> =
        refused.diagnostics.iter().map(|held| (held.code, held.message.as_str(), held.range)).collect();
    assert_eq!(
        found,
        [(
            CelCheckCode::InvalidArgument,
            "fixed: decimal places must be an integer 0-10, got 11 (in `fixed(1.0, 11)`)",
            SourceRange { start: 9, end: 23 }
        )]
    );
    // A computed argument is not judged: the guard is handed nothing for it.
    assert_eq!(environment.check("fixed(1.0, digits)").diagnostics, []);
}

/// `(name, signature, signatures, category, deterministic, host-backed, guards its
/// literals)`, as Node's `functionCatalog()` answers each, in its order.
const NODE_CATALOG: [(&str, &str, &[&str], &str, bool, bool, bool); 67] = [
    ("join", "join(list, string): string", &["join(list, string): string"], "collection", true, false, false),
    ("keys", "keys(map): list", &["keys(map): list"], "collection", true, false, false),
    ("values", "values(map): list", &["values(map): list"], "collection", true, false, false),
    ("distinct", "distinct(list): list", &["distinct(list): list"], "collection", true, false, false),
    ("reverse", "reverse(list): list", &["reverse(list): list"], "collection", true, false, false),
    ("flatten", "flatten(list): list", &["flatten(list): list"], "collection", true, false, false),
    ("sort", "sort(list): list", &["sort(list): list"], "collection", true, false, false),
    ("range", "range(int): list<int>", &["range(int): list<int>"], "collection", true, false, false),
    ("enumerate", "enumerate(list): list", &["enumerate(list): list"], "collection", true, false, false),
    ("lower", "lower(string): string", &["lower(string): string"], "string", true, false, false),
    ("upper", "upper(string): string", &["upper(string): string"], "string", true, false, false),
    ("trim", "trim(string): string", &["trim(string): string"], "string", true, false, false),
    ("replace", "replace(string, string, string): string", &["replace(string, string, string): string"], "string", true, false, false),
    ("split", "split(string, string): list", &["split(string, string): list"], "string", true, false, false),
    ("regexReplace", "regexReplace(string, string, string, string?): string", &["regexReplace(string, string, string): string", "regexReplace(string, string, string, string): string"], "string", true, false, true),
    ("regexExtract", "regexExtract(string, string, string?): string", &["regexExtract(string, string): string", "regexExtract(string, string, string): string"], "string", true, false, true),
    ("regexExtractAll", "regexExtractAll(string, string, string?): list<string>", &["regexExtractAll(string, string): list<string>", "regexExtractAll(string, string, string): list<string>"], "string", true, false, true),
    ("regexGroups", "regexGroups(string, string, string?): list<string>", &["regexGroups(string, string): list<string>", "regexGroups(string, string, string): list<string>"], "string", true, false, true),
    ("trimPrefix", "trimPrefix(string, string): string", &["trimPrefix(string, string): string"], "string", true, false, false),
    ("trimSuffix", "trimSuffix(string, string): string", &["trimSuffix(string, string): string"], "string", true, false, false),
    ("slice", "slice(dyn, int, int): dyn", &["slice(bytes, int, int): dyn", "slice(string, int, int): dyn", "slice(list, int, int): dyn"], "collection", true, false, false),
    ("abs", "abs(dyn): double", &["abs(dyn): double"], "math", true, false, false),
    ("floor", "floor(dyn): double", &["floor(dyn): double"], "math", true, false, false),
    ("ceil", "ceil(dyn): double", &["ceil(dyn): double"], "math", true, false, false),
    ("round", "round(dyn, int?): double", &["round(double): double", "round(int): double", "round(double, int): double", "round(int, int): double"], "math", true, false, true),
    ("min", "min(list): dyn", &["min(list): dyn"], "math", true, false, false),
    ("max", "max(list): dyn", &["max(list): dyn"], "math", true, false, false),
    ("sum", "sum(list): double", &["sum(list): double"], "math", true, false, false),
    ("avg", "avg(list): dyn", &["avg(list): dyn"], "math", true, false, false),
    ("json", "json(dyn): string", &["json(dyn): string"], "json", true, true, false),
    ("parseJson", "parseJson(string): dyn", &["parseJson(string): dyn"], "json", true, false, false),
    ("joinPath", "string.joinPath(string): string", &["string.joinPath(string): string"], "string", true, true, false),
    ("base64Encode", "base64Encode(string): string", &["base64Encode(string): string"], "encoding", true, true, false),
    ("base64Decode", "base64Decode(string): string", &["base64Decode(string): string"], "encoding", true, true, false),
    ("bytesFromBase64", "bytesFromBase64(string): bytes", &["bytesFromBase64(string): bytes"], "encoding", true, false, false),
    ("bytesToBase64", "bytesToBase64(bytes): string", &["bytesToBase64(bytes): string"], "encoding", true, false, false),
    ("urlEncode", "urlEncode(string): string", &["urlEncode(string): string"], "encoding", true, false, false),
    ("urlDecode", "urlDecode(string): string", &["urlDecode(string): string"], "encoding", true, false, false),
    ("sha256", "sha256(string): string", &["sha256(string): string"], "hashing", true, true, false),
    ("md5", "md5(string): string", &["md5(string): string"], "hashing", true, true, false),
    ("sha1", "sha1(string): string", &["sha1(string): string"], "hashing", true, true, false),
    ("sha512", "sha512(string): string", &["sha512(string): string"], "hashing", true, true, false),
    ("hmac", "hmac(string, string, string): string", &["hmac(string, string, string): string"], "hashing", true, true, false),
    ("default", "default(dyn, dyn): dyn", &["default(dyn, dyn): dyn"], "null", true, false, false),
    ("coalesce", "coalesce(list): dyn", &["coalesce(list): dyn"], "null", true, false, false),
    ("now", "now(): timestamp", &["now(): google.protobuf.Timestamp"], "time", false, false, false),
    ("nowIso", "nowIso(string?): string", &["nowIso(): string", "nowIso(string): string"], "time", false, false, false),
    ("today", "today(string?): string", &["today(): string", "today(string): string"], "time", false, false, false),
    ("nowMillis", "nowMillis(): int", &["nowMillis(): int"], "time", false, false, false),
    ("nowSeconds", "nowSeconds(): int", &["nowSeconds(): int"], "time", false, false, false),
    ("format", "format(dyn, string): string", &["format(double, string): string", "format(int, string): string"], "formatting", true, false, true),
    ("fixed", "fixed(dyn, int): string", &["fixed(double, int): string", "fixed(int, int): string"], "formatting", true, false, true),
    ("formatDuration", "formatDuration(dyn, int): string", &["formatDuration(double, int): string", "formatDuration(int, int): string"], "formatting", true, false, true),
    ("dateIn", "dateIn(timestamp, string?): string", &["dateIn(google.protobuf.Timestamp): string", "dateIn(google.protobuf.Timestamp, string): string"], "time", true, false, true),
    ("isoIn", "isoIn(timestamp, string?): string", &["isoIn(google.protobuf.Timestamp): string", "isoIn(google.protobuf.Timestamp, string): string"], "time", true, false, true),
    ("startOfMonth", "startOfMonth(timestamp, string?): timestamp", &["startOfMonth(google.protobuf.Timestamp): google.protobuf.Timestamp", "startOfMonth(google.protobuf.Timestamp, string): google.protobuf.Timestamp"], "time", true, false, true),
    ("addMonths", "addMonths(timestamp, int, string?): timestamp", &["addMonths(google.protobuf.Timestamp, int): google.protobuf.Timestamp", "addMonths(google.protobuf.Timestamp, int, string): google.protobuf.Timestamp"], "time", true, false, true),
    ("compact", "compact(dyn): dyn", &["compact(list): list", "compact(map): map"], "collection", true, false, false),
    ("merge", "merge(map, map): map", &["merge(map, map): map"], "collection", true, false, false),
    ("uuidv1", "uuidv1(): string", &["uuidv1(): string"], "uuid", false, false, false),
    ("uuidv4", "uuidv4(): string", &["uuidv4(): string"], "uuid", false, false, false),
    ("uuidv6", "uuidv6(): string", &["uuidv6(): string"], "uuid", false, false, false),
    ("uuidv7", "uuidv7(): string", &["uuidv7(): string"], "uuid", false, false, false),
    ("uuidv3", "uuidv3(string, string): string", &["uuidv3(string, string): string"], "uuid", true, false, false),
    ("uuidv5", "uuidv5(string, string): string", &["uuidv5(string, string): string"], "uuid", true, false, false),
    ("uuidValidate", "uuidValidate(string): bool", &["uuidValidate(string): bool"], "uuid", true, false, false),
    ("uuidVersion", "uuidVersion(string): int", &["uuidVersion(string): int"], "uuid", true, false, false),
];

#[test]
fn lists_the_catalog_as_node_does() {
    assert_eq!(FUNCTION_CATALOG_GENERATION, 1);
    assert_eq!(
        catalog_categories(),
        ["collection", "encoding", "formatting", "hashing", "json", "math", "null", "string", "time", "uuid"]
    );
    let listed: Vec<_> = function_catalog()
        .iter()
        .map(|entry| {
            (
                entry.name.as_str(),
                entry.signature.as_str(),
                entry.signatures.iter().map(String::as_str).collect::<Vec<_>>(),
                entry.category.as_str(),
                entry.deterministic,
                entry.host_backed,
                entry.checks_literal_arguments,
            )
        })
        .collect();
    let expected: Vec<_> = NODE_CATALOG
        .iter()
        .map(|(name, signature, signatures, category, deterministic, host_backed, guards)| {
            (*name, *signature, signatures.to_vec(), *category, *deterministic, *host_backed, *guards)
        })
        .collect();
    assert_eq!(listed, expected);
    assert!(function_catalog().iter().all(|entry| !entry.summary.is_empty()));
    assert_eq!(catalog_signatures().len(), 86);
}
