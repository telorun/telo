//! The standard library as an environment lists it: every function `definitions()`
//! answers by default (207) and with optional types (214), field for field, and every
//! constant.
//!
//! No Node test file is the twin of this one. Every row is the Node build's
//! `definitions()`, executed: `@telorun/cel 0.118.0 at 63c81d00`. Every standard
//! function lists as deterministic, engine-backed, with no `throws`, no description and
//! the origin `standard-library` — which Node's run also answered, for each of the 214.

use telorun_cel::{
    map_of, standard_library_signatures, CelEnvironment, CelEnvironmentOptions, FunctionDefinition,
    VariableDefinition, STANDARD_LIBRARY_GENERATION, STRING, TYPE,
};

/// `(registered only with optional types, name, signature, receiver, parameters, returns)`,
/// in the order the optional environment lists them; the default one lists the others in
/// the same order.
type Row = (bool, &'static str, &'static str, Option<&'static str>, &'static [&'static str], &'static str);

const NODE_FUNCTIONS: [Row; 214] = [
        (false, "!", "!(bool): bool", None, &["bool"], "bool"),
        (true , "!=", "!=(optional<A>, optional<A>): bool", None, &["optional<A>", "optional<A>"], "bool"),
        (false, "!=", "!=(int, int): bool", None, &["int", "int"], "bool"),
        (false, "!=", "!=(uint, uint): bool", None, &["uint", "uint"], "bool"),
        (false, "!=", "!=(double, double): bool", None, &["double", "double"], "bool"),
        (false, "!=", "!=(bool, bool): bool", None, &["bool", "bool"], "bool"),
        (false, "!=", "!=(string, string): bool", None, &["string", "string"], "bool"),
        (false, "!=", "!=(bytes, bytes): bool", None, &["bytes", "bytes"], "bool"),
        (false, "!=", "!=(null, null): bool", None, &["null", "null"], "bool"),
        (false, "!=", "!=(type, type): bool", None, &["type", "type"], "bool"),
        (false, "!=", "!=(list<A>, list<A>): bool", None, &["list<A>", "list<A>"], "bool"),
        (false, "!=", "!=(map<K, V>, map<K, V>): bool", None, &["map<K, V>", "map<K, V>"], "bool"),
        (false, "!=", "!=(google.protobuf.Timestamp, google.protobuf.Timestamp): bool", None, &["google.protobuf.Timestamp", "google.protobuf.Timestamp"], "bool"),
        (false, "!=", "!=(google.protobuf.Duration, google.protobuf.Duration): bool", None, &["google.protobuf.Duration", "google.protobuf.Duration"], "bool"),
        (false, "%", "%(int, int): int", None, &["int", "int"], "int"),
        (false, "%", "%(uint, uint): uint", None, &["uint", "uint"], "uint"),
        (false, "*", "*(int, int): int", None, &["int", "int"], "int"),
        (false, "*", "*(uint, uint): uint", None, &["uint", "uint"], "uint"),
        (false, "*", "*(double, double): double", None, &["double", "double"], "double"),
        (false, "+", "+(int, int): int", None, &["int", "int"], "int"),
        (false, "+", "+(uint, uint): uint", None, &["uint", "uint"], "uint"),
        (false, "+", "+(double, double): double", None, &["double", "double"], "double"),
        (false, "+", "+(string, string): string", None, &["string", "string"], "string"),
        (false, "+", "+(bytes, bytes): bytes", None, &["bytes", "bytes"], "bytes"),
        (false, "+", "+(list<A>, list<A>): list<A>", None, &["list<A>", "list<A>"], "list<A>"),
        (false, "+", "+(google.protobuf.Timestamp, google.protobuf.Duration): google.protobuf.Timestamp", None, &["google.protobuf.Timestamp", "google.protobuf.Duration"], "google.protobuf.Timestamp"),
        (false, "+", "+(google.protobuf.Duration, google.protobuf.Timestamp): google.protobuf.Timestamp", None, &["google.protobuf.Duration", "google.protobuf.Timestamp"], "google.protobuf.Timestamp"),
        (false, "+", "+(google.protobuf.Duration, google.protobuf.Duration): google.protobuf.Duration", None, &["google.protobuf.Duration", "google.protobuf.Duration"], "google.protobuf.Duration"),
        (false, "-", "-(int): int", None, &["int"], "int"),
        (false, "-", "-(double): double", None, &["double"], "double"),
        (false, "-", "-(int, int): int", None, &["int", "int"], "int"),
        (false, "-", "-(uint, uint): uint", None, &["uint", "uint"], "uint"),
        (false, "-", "-(double, double): double", None, &["double", "double"], "double"),
        (false, "-", "-(google.protobuf.Timestamp, google.protobuf.Timestamp): google.protobuf.Duration", None, &["google.protobuf.Timestamp", "google.protobuf.Timestamp"], "google.protobuf.Duration"),
        (false, "-", "-(google.protobuf.Timestamp, google.protobuf.Duration): google.protobuf.Timestamp", None, &["google.protobuf.Timestamp", "google.protobuf.Duration"], "google.protobuf.Timestamp"),
        (false, "-", "-(google.protobuf.Duration, google.protobuf.Duration): google.protobuf.Duration", None, &["google.protobuf.Duration", "google.protobuf.Duration"], "google.protobuf.Duration"),
        (false, "/", "/(int, int): int", None, &["int", "int"], "int"),
        (false, "/", "/(uint, uint): uint", None, &["uint", "uint"], "uint"),
        (false, "/", "/(double, double): double", None, &["double", "double"], "double"),
        (false, "<", "<(int, int): bool", None, &["int", "int"], "bool"),
        (false, "<", "<(uint, uint): bool", None, &["uint", "uint"], "bool"),
        (false, "<", "<(double, double): bool", None, &["double", "double"], "bool"),
        (false, "<", "<(bool, bool): bool", None, &["bool", "bool"], "bool"),
        (false, "<", "<(string, string): bool", None, &["string", "string"], "bool"),
        (false, "<", "<(bytes, bytes): bool", None, &["bytes", "bytes"], "bool"),
        (false, "<", "<(google.protobuf.Timestamp, google.protobuf.Timestamp): bool", None, &["google.protobuf.Timestamp", "google.protobuf.Timestamp"], "bool"),
        (false, "<", "<(google.protobuf.Duration, google.protobuf.Duration): bool", None, &["google.protobuf.Duration", "google.protobuf.Duration"], "bool"),
        (false, "<", "<(int, uint): bool", None, &["int", "uint"], "bool"),
        (false, "<", "<(int, double): bool", None, &["int", "double"], "bool"),
        (false, "<", "<(uint, int): bool", None, &["uint", "int"], "bool"),
        (false, "<", "<(uint, double): bool", None, &["uint", "double"], "bool"),
        (false, "<", "<(double, int): bool", None, &["double", "int"], "bool"),
        (false, "<", "<(double, uint): bool", None, &["double", "uint"], "bool"),
        (false, "<=", "<=(int, int): bool", None, &["int", "int"], "bool"),
        (false, "<=", "<=(uint, uint): bool", None, &["uint", "uint"], "bool"),
        (false, "<=", "<=(double, double): bool", None, &["double", "double"], "bool"),
        (false, "<=", "<=(bool, bool): bool", None, &["bool", "bool"], "bool"),
        (false, "<=", "<=(string, string): bool", None, &["string", "string"], "bool"),
        (false, "<=", "<=(bytes, bytes): bool", None, &["bytes", "bytes"], "bool"),
        (false, "<=", "<=(google.protobuf.Timestamp, google.protobuf.Timestamp): bool", None, &["google.protobuf.Timestamp", "google.protobuf.Timestamp"], "bool"),
        (false, "<=", "<=(google.protobuf.Duration, google.protobuf.Duration): bool", None, &["google.protobuf.Duration", "google.protobuf.Duration"], "bool"),
        (false, "<=", "<=(int, uint): bool", None, &["int", "uint"], "bool"),
        (false, "<=", "<=(int, double): bool", None, &["int", "double"], "bool"),
        (false, "<=", "<=(uint, int): bool", None, &["uint", "int"], "bool"),
        (false, "<=", "<=(uint, double): bool", None, &["uint", "double"], "bool"),
        (false, "<=", "<=(double, int): bool", None, &["double", "int"], "bool"),
        (false, "<=", "<=(double, uint): bool", None, &["double", "uint"], "bool"),
        (true , "==", "==(optional<A>, optional<A>): bool", None, &["optional<A>", "optional<A>"], "bool"),
        (false, "==", "==(int, int): bool", None, &["int", "int"], "bool"),
        (false, "==", "==(uint, uint): bool", None, &["uint", "uint"], "bool"),
        (false, "==", "==(double, double): bool", None, &["double", "double"], "bool"),
        (false, "==", "==(bool, bool): bool", None, &["bool", "bool"], "bool"),
        (false, "==", "==(string, string): bool", None, &["string", "string"], "bool"),
        (false, "==", "==(bytes, bytes): bool", None, &["bytes", "bytes"], "bool"),
        (false, "==", "==(null, null): bool", None, &["null", "null"], "bool"),
        (false, "==", "==(type, type): bool", None, &["type", "type"], "bool"),
        (false, "==", "==(list<A>, list<A>): bool", None, &["list<A>", "list<A>"], "bool"),
        (false, "==", "==(map<K, V>, map<K, V>): bool", None, &["map<K, V>", "map<K, V>"], "bool"),
        (false, "==", "==(google.protobuf.Timestamp, google.protobuf.Timestamp): bool", None, &["google.protobuf.Timestamp", "google.protobuf.Timestamp"], "bool"),
        (false, "==", "==(google.protobuf.Duration, google.protobuf.Duration): bool", None, &["google.protobuf.Duration", "google.protobuf.Duration"], "bool"),
        (false, ">", ">(int, int): bool", None, &["int", "int"], "bool"),
        (false, ">", ">(uint, uint): bool", None, &["uint", "uint"], "bool"),
        (false, ">", ">(double, double): bool", None, &["double", "double"], "bool"),
        (false, ">", ">(bool, bool): bool", None, &["bool", "bool"], "bool"),
        (false, ">", ">(string, string): bool", None, &["string", "string"], "bool"),
        (false, ">", ">(bytes, bytes): bool", None, &["bytes", "bytes"], "bool"),
        (false, ">", ">(google.protobuf.Timestamp, google.protobuf.Timestamp): bool", None, &["google.protobuf.Timestamp", "google.protobuf.Timestamp"], "bool"),
        (false, ">", ">(google.protobuf.Duration, google.protobuf.Duration): bool", None, &["google.protobuf.Duration", "google.protobuf.Duration"], "bool"),
        (false, ">", ">(int, uint): bool", None, &["int", "uint"], "bool"),
        (false, ">", ">(int, double): bool", None, &["int", "double"], "bool"),
        (false, ">", ">(uint, int): bool", None, &["uint", "int"], "bool"),
        (false, ">", ">(uint, double): bool", None, &["uint", "double"], "bool"),
        (false, ">", ">(double, int): bool", None, &["double", "int"], "bool"),
        (false, ">", ">(double, uint): bool", None, &["double", "uint"], "bool"),
        (false, ">=", ">=(int, int): bool", None, &["int", "int"], "bool"),
        (false, ">=", ">=(uint, uint): bool", None, &["uint", "uint"], "bool"),
        (false, ">=", ">=(double, double): bool", None, &["double", "double"], "bool"),
        (false, ">=", ">=(bool, bool): bool", None, &["bool", "bool"], "bool"),
        (false, ">=", ">=(string, string): bool", None, &["string", "string"], "bool"),
        (false, ">=", ">=(bytes, bytes): bool", None, &["bytes", "bytes"], "bool"),
        (false, ">=", ">=(google.protobuf.Timestamp, google.protobuf.Timestamp): bool", None, &["google.protobuf.Timestamp", "google.protobuf.Timestamp"], "bool"),
        (false, ">=", ">=(google.protobuf.Duration, google.protobuf.Duration): bool", None, &["google.protobuf.Duration", "google.protobuf.Duration"], "bool"),
        (false, ">=", ">=(int, uint): bool", None, &["int", "uint"], "bool"),
        (false, ">=", ">=(int, double): bool", None, &["int", "double"], "bool"),
        (false, ">=", ">=(uint, int): bool", None, &["uint", "int"], "bool"),
        (false, ">=", ">=(uint, double): bool", None, &["uint", "double"], "bool"),
        (false, ">=", ">=(double, int): bool", None, &["double", "int"], "bool"),
        (false, ">=", ">=(double, uint): bool", None, &["double", "uint"], "bool"),
        (false, "at", "bytes.at(int): int", Some("bytes"), &["int"], "int"),
        (false, "base64", "bytes.base64(): string", Some("bytes"), &[], "string"),
        (false, "bool", "bool(bool): bool", None, &["bool"], "bool"),
        (false, "bool", "bool(string): bool", None, &["string"], "bool"),
        (false, "bytes", "bytes(bytes): bytes", None, &["bytes"], "bytes"),
        (false, "bytes", "bytes(string): bytes", None, &["string"], "bytes"),
        (false, "contains", "string.contains(string): bool", Some("string"), &["string"], "bool"),
        (false, "double", "double(double): double", None, &["double"], "double"),
        (false, "double", "double(int): double", None, &["int"], "double"),
        (false, "double", "double(uint): double", None, &["uint"], "double"),
        (false, "double", "double(string): double", None, &["string"], "double"),
        (false, "duration", "duration(string): google.protobuf.Duration", None, &["string"], "google.protobuf.Duration"),
        (false, "duration", "duration(google.protobuf.Duration): google.protobuf.Duration", None, &["google.protobuf.Duration"], "google.protobuf.Duration"),
        (false, "dyn", "dyn(A): dyn", None, &["A"], "dyn"),
        (false, "endsWith", "string.endsWith(string): bool", Some("string"), &["string"], "bool"),
        (false, "getDate", "google.protobuf.Timestamp.getDate(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getDate", "google.protobuf.Timestamp.getDate(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getDayOfMonth", "google.protobuf.Timestamp.getDayOfMonth(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getDayOfMonth", "google.protobuf.Timestamp.getDayOfMonth(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getDayOfWeek", "google.protobuf.Timestamp.getDayOfWeek(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getDayOfWeek", "google.protobuf.Timestamp.getDayOfWeek(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getDayOfYear", "google.protobuf.Timestamp.getDayOfYear(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getDayOfYear", "google.protobuf.Timestamp.getDayOfYear(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getFullYear", "google.protobuf.Timestamp.getFullYear(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getFullYear", "google.protobuf.Timestamp.getFullYear(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getHours", "google.protobuf.Timestamp.getHours(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getHours", "google.protobuf.Timestamp.getHours(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getHours", "google.protobuf.Duration.getHours(): int", Some("google.protobuf.Duration"), &[], "int"),
        (false, "getMilliseconds", "google.protobuf.Timestamp.getMilliseconds(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getMilliseconds", "google.protobuf.Timestamp.getMilliseconds(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getMilliseconds", "google.protobuf.Duration.getMilliseconds(): int", Some("google.protobuf.Duration"), &[], "int"),
        (false, "getMinutes", "google.protobuf.Timestamp.getMinutes(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getMinutes", "google.protobuf.Timestamp.getMinutes(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getMinutes", "google.protobuf.Duration.getMinutes(): int", Some("google.protobuf.Duration"), &[], "int"),
        (false, "getMonth", "google.protobuf.Timestamp.getMonth(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getMonth", "google.protobuf.Timestamp.getMonth(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getSeconds", "google.protobuf.Timestamp.getSeconds(): int", Some("google.protobuf.Timestamp"), &[], "int"),
        (false, "getSeconds", "google.protobuf.Timestamp.getSeconds(string): int", Some("google.protobuf.Timestamp"), &["string"], "int"),
        (false, "getSeconds", "google.protobuf.Duration.getSeconds(): int", Some("google.protobuf.Duration"), &[], "int"),
        (true , "hasValue", "optional<A>.hasValue(): bool", Some("optional<A>"), &[], "bool"),
        (false, "hex", "bytes.hex(): string", Some("bytes"), &[], "string"),
        (false, "in", "in(A, list<A>): bool", None, &["A", "list<A>"], "bool"),
        (false, "in", "in(K, map<K, V>): bool", None, &["K", "map<K, V>"], "bool"),
        (false, "indexOf", "string.indexOf(string): int", Some("string"), &["string"], "int"),
        (false, "indexOf", "string.indexOf(string, int): int", Some("string"), &["string", "int"], "int"),
        (false, "int", "int(int): int", None, &["int"], "int"),
        (false, "int", "int(uint): int", None, &["uint"], "int"),
        (false, "int", "int(double): int", None, &["double"], "int"),
        (false, "int", "int(string): int", None, &["string"], "int"),
        (false, "int", "int(google.protobuf.Timestamp): int", None, &["google.protobuf.Timestamp"], "int"),
        (false, "int", "int(google.protobuf.Duration): int", None, &["google.protobuf.Duration"], "int"),
        (false, "join", "list<string>.join(): string", Some("list<string>"), &[], "string"),
        (false, "join", "list<string>.join(string): string", Some("list<string>"), &["string"], "string"),
        (false, "json", "bytes.json(): dyn", Some("bytes"), &[], "dyn"),
        (false, "lastIndexOf", "string.lastIndexOf(string): int", Some("string"), &["string"], "int"),
        (false, "lastIndexOf", "string.lastIndexOf(string, int): int", Some("string"), &["string", "int"], "int"),
        (false, "lowerAscii", "string.lowerAscii(): string", Some("string"), &[], "string"),
        (false, "matches", "matches(string, string): bool", None, &["string", "string"], "bool"),
        (false, "matches", "string.matches(string): bool", Some("string"), &["string"], "bool"),
        (true , "or", "optional<A>.or(optional<A>): optional<A>", Some("optional<A>"), &["optional<A>"], "optional<A>"),
        (true , "orValue", "optional<A>.orValue(A): A", Some("optional<A>"), &["A"], "A"),
        (false, "size", "size(string): int", None, &["string"], "int"),
        (false, "size", "size(bytes): int", None, &["bytes"], "int"),
        (false, "size", "size(list<A>): int", None, &["list<A>"], "int"),
        (false, "size", "size(map<K, V>): int", None, &["map<K, V>"], "int"),
        (false, "size", "string.size(): int", Some("string"), &[], "int"),
        (false, "size", "bytes.size(): int", Some("bytes"), &[], "int"),
        (false, "size", "list<A>.size(): int", Some("list<A>"), &[], "int"),
        (false, "size", "map<K, V>.size(): int", Some("map<K, V>"), &[], "int"),
        (false, "split", "string.split(string): list<string>", Some("string"), &["string"], "list<string>"),
        (false, "split", "string.split(string, int): list<string>", Some("string"), &["string", "int"], "list<string>"),
        (false, "startsWith", "string.startsWith(string): bool", Some("string"), &["string"], "bool"),
        (false, "string", "string(string): string", None, &["string"], "string"),
        (false, "string", "string(bool): string", None, &["bool"], "string"),
        (false, "string", "string(int): string", None, &["int"], "string"),
        (false, "string", "string(uint): string", None, &["uint"], "string"),
        (false, "string", "string(double): string", None, &["double"], "string"),
        (false, "string", "string(bytes): string", None, &["bytes"], "string"),
        (false, "string", "string(google.protobuf.Timestamp): string", None, &["google.protobuf.Timestamp"], "string"),
        (false, "string", "string(google.protobuf.Duration): string", None, &["google.protobuf.Duration"], "string"),
        (false, "string", "bytes.string(): string", Some("bytes"), &[], "string"),
        (false, "substring", "string.substring(int): string", Some("string"), &["int"], "string"),
        (false, "substring", "string.substring(int, int): string", Some("string"), &["int", "int"], "string"),
        (false, "timestamp", "timestamp(string): google.protobuf.Timestamp", None, &["string"], "google.protobuf.Timestamp"),
        (false, "timestamp", "timestamp(int): google.protobuf.Timestamp", None, &["int"], "google.protobuf.Timestamp"),
        (false, "timestamp", "timestamp(google.protobuf.Timestamp): google.protobuf.Timestamp", None, &["google.protobuf.Timestamp"], "google.protobuf.Timestamp"),
        (false, "trim", "string.trim(): string", Some("string"), &[], "string"),
        (false, "type", "type(int): type", None, &["int"], "type"),
        (false, "type", "type(uint): type", None, &["uint"], "type"),
        (false, "type", "type(double): type", None, &["double"], "type"),
        (false, "type", "type(bool): type", None, &["bool"], "type"),
        (false, "type", "type(string): type", None, &["string"], "type"),
        (false, "type", "type(bytes): type", None, &["bytes"], "type"),
        (false, "type", "type(null): type", None, &["null"], "type"),
        (false, "type", "type(type): type", None, &["type"], "type"),
        (false, "type", "type(list<A>): type", None, &["list<A>"], "type"),
        (false, "type", "type(map<K, V>): type", None, &["map<K, V>"], "type"),
        (false, "type", "type(google.protobuf.Timestamp): type", None, &["google.protobuf.Timestamp"], "type"),
        (false, "type", "type(google.protobuf.Duration): type", None, &["google.protobuf.Duration"], "type"),
        (true , "type", "type(optional<A>): type", None, &["optional<A>"], "type"),
        (false, "uint", "uint(uint): uint", None, &["uint"], "uint"),
        (false, "uint", "uint(int): uint", None, &["int"], "uint"),
        (false, "uint", "uint(double): uint", None, &["double"], "uint"),
        (false, "uint", "uint(string): uint", None, &["string"], "uint"),
        (false, "upperAscii", "string.upperAscii(): string", Some("string"), &[], "string"),
        (true , "value", "optional<A>.value(): A", Some("optional<A>"), &[], "A"),
];

fn listed(row: &Row) -> FunctionDefinition {
    let (_, name, signature, receiver, parameters, returns) = *row;
    FunctionDefinition {
        name: name.into(),
        signature: signature.into(),
        receiver_type: receiver.map(Into::into),
        parameters: parameters.iter().map(|parameter| parameter.to_string()).collect(),
        returns: returns.into(),
        deterministic: true,
        host_backed: false,
        throws: None,
        description: None,
        origin: Some("standard-library".into()),
    }
}

#[test]
fn lists_every_standard_function_as_node_does() {
    let optional = CelEnvironment::new(CelEnvironmentOptions { enable_optional_types: true, ..Default::default() });
    let expected: Vec<FunctionDefinition> = NODE_FUNCTIONS.iter().map(listed).collect();
    assert_eq!(optional.definitions().functions, expected);
    assert_eq!(expected.len(), 214);

    let expected: Vec<FunctionDefinition> = NODE_FUNCTIONS.iter().filter(|row| !row.0).map(listed).collect();
    assert_eq!(CelEnvironment::default().definitions().functions, expected);
    assert_eq!(expected.len(), 207);
}

#[test]
fn lists_every_standard_constant_as_node_does() {
    let constant = |name: &str| VariableDefinition {
        name: name.into(),
        ty: TYPE,
        type_name: "type".into(),
        description: None,
        constant: true,
    };
    let google = VariableDefinition {
        name: "google".into(),
        ty: map_of(STRING, map_of(STRING, TYPE)),
        type_name: "map<string, map<string, type>>".into(),
        description: Some("The well-known type names, so that type(x) == google.protobuf.Timestamp can be written.".into()),
        constant: true,
    };
    let names = ["bool", "bytes", "double", "google", "int", "list", "map", "null_type", "optional_type", "string", "type", "uint"];
    let listing = |optional: bool| -> Vec<VariableDefinition> {
        names
            .iter()
            .filter(|name| optional || **name != "optional_type")
            .map(|name| if *name == "google" { google.clone() } else { constant(name) })
            .collect()
    };
    let optional = CelEnvironment::new(CelEnvironmentOptions { enable_optional_types: true, ..Default::default() });
    assert_eq!(optional.definitions().variables, listing(true));
    assert_eq!(CelEnvironment::default().definitions().variables, listing(false));
}

#[test]
fn reads_the_signature_data_of_the_generation_it_declares() {
    assert_eq!(STANDARD_LIBRARY_GENERATION, 1);
    let signatures = standard_library_signatures();
    assert_eq!(signatures.len(), 104);
    assert_eq!((signatures[0].as_str(), signatures[103].as_str()), ("bool(bool): bool", "optional<A>.orValue(A): A"));
}
