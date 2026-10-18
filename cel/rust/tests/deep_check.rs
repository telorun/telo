//! The checker recurses with nothing: a tree of any depth is checked, and a fix written,
//! on a stack of 256 KiB, in a debug build.
//!
//! No Node test file is the twin of this one. What is Node's answer, executed
//! (`@telorun/cel 0.118.0 at 63c81d00`): each construct three deep — its type name, its
//! diagnostics and fixes, the number of calls listed — and the same four deep, which fixes
//! where each answer moves with depth. What is this crate's own, because Node's walk throws
//! `RangeError` on these trees: that each is checked at all, and the answer of the
//! three-deep row carried to a hundred thousand.

mod check_support;
mod support;

use std::sync::Arc;

use check_support::{fixed, found, schema};
use telorun_cel::CelCheckCode::*;
use telorun_cel::{
    CelCheckDiagnostic, CelEnvironment, CelEnvironmentOptions, CelExpression, CelNode, CelParseLimits,
    NamespaceOptions,
};

/// The one stack size any test of this crate names.
const STACK_BYTES: usize = 256 * 1024;

const DEEP: usize = 100_000;

fn on_a_small_stack(work: impl FnOnce() + Send + 'static) {
    let thread = std::thread::Builder::new().stack_size(STACK_BYTES).spawn(work).expect("the thread starts");
    thread.join().expect("the work ran to its end");
}

fn deep_environment() -> CelEnvironment {
    let mut environment = CelEnvironment::new(CelEnvironmentOptions {
        unlisted_variables_are_dyn: true,
        limits: CelParseLimits { max_nodes: 10 * DEEP, max_depth: 10 * DEEP, ..Default::default() },
        ..Default::default()
    });
    environment
        .register_variable(
            "request",
            schema(r#"{"type":"object","properties":{"body":{"type":["object","null"],"properties":{"id":{"type":"string"}}}}}"#),
            None,
        )
        .unwrap();
    environment.register_variable("l", "list<int>", None).unwrap();
    environment.register_variable("a.b", "map<string, dyn>", None).unwrap();
    environment.register_namespace("Ns", vec!["f(int): int".into()], NamespaceOptions::default()).unwrap();
    environment
}

/// A construct nested `n` deep, and what checking it answers: the type name, the
/// diagnostics and the number of calls listed.
struct Nesting {
    source: String,
    type_name: String,
    diagnostics: Vec<CelCheckDiagnostic>,
    calls: usize,
}

const LABELS: [&str; 13] = [
    "negation",
    "conditional",
    "list",
    "map",
    "comprehension",
    "bind",
    "guarded",
    "qualified",
    "index",
    "shape",
    "renamed",
    "dotted",
    "formed",
];

/// Node's three-deep and four-deep answers, carried to `n`.
fn nesting(label: &str, n: usize) -> Nesting {
    let around = |open: &str, inner: &str, close: &str| format!("{}{inner}{}", open.repeat(n), close.repeat(n));
    let nested_type = |open: &str, inner: &str| format!("{}{inner}{}", open.repeat(n), ">".repeat(n));
    let plain = |source: String, type_name: &str| Nesting { source, type_name: type_name.into(), diagnostics: vec![], calls: 0 };
    let at = |offset: usize| u32::try_from(offset).expect("an offset fits");
    match label {
        "negation" => plain(around("-(", "1", ")"), "int"),
        "conditional" => plain(around("true ? 1 : (", "1", ")"), "int"),
        "list" => plain(around("[", "1", "]"), &nested_type("list<", "int")),
        "map" => plain(around("{'a': ", "1", "}"), &nested_type("map<string, ", "int")),
        "comprehension" => plain(around("[1].map(x, ", "x", ")"), &nested_type("list<", "int")),
        "bind" => plain(around("cel.bind(x, 1, ", "x", ")"), "int"),
        "guarded" => plain(around("request.body != null && (", "request.body.id == 'x'", ")"), "bool"),
        "qualified" => Nesting { calls: n, ..plain(around("Ns.f(", "1", ")"), "int") },
        "index" => plain(around("l[", "0", "]"), "int"),
        "shape" => Nesting {
            diagnostics: vec![found(InvalidArgument, "map binds a name here, and this is not a name", at(11 * n + 8), at(11 * n + 9))],
            ..plain(around("[1].map(x, ", "[1].map(1, x)", ")"), &nested_type("list<", "dyn"))
        },
        "renamed" => Nesting {
            diagnostics: vec![fixed(
                UnknownFunction,
                "no function named \"Size\" is registered \u{2014} the closest taking 1 argument: size, int, type, uint, bool",
                0,
                9,
                &format!("size(\"a\"){}", ".a".repeat(n)),
            )],
            calls: 1,
            ..plain(format!("Size('a'){}", ".a".repeat(n)), "dyn")
        },
        "dotted" => plain(format!("a{}", ".b".repeat(n)), "dyn"),
        "formed" => Nesting {
            diagnostics: vec![fixed(
                WrongCallForm,
                "\"startsWith\" is called on a value: string.startsWith(string): bool",
                at(n),
                at(n + 20),
                &around("[", "\"a\".startsWith(\"b\")", "]"),
            )],
            calls: 1,
            ..plain(around("[", "startsWith('a', 'b')", "]"), &nested_type("list<", "dyn"))
        },
        _ => unreachable!("{label} is a nesting"),
    }
}

fn assert_checks(environment: &CelEnvironment, label: &str, nesting: &Nesting) {
    let result = environment.check(&nesting.source);
    assert_eq!(result.type_name, nesting.type_name, "{label}");
    assert_eq!(result.diagnostics, nesting.diagnostics, "{label}");
    assert_eq!(result.calls.len(), nesting.calls, "{label}");
}

#[test]
fn checks_each_construct_three_and_four_deep_as_node_does() {
    // Node's own rows for three deep, written out, against which the carried answer is held.
    let three = nesting("list", 3);
    assert_eq!((three.source.as_str(), three.type_name.as_str()), ("[[[1]]]", "list<list<list<int>>>"));
    let renamed = nesting("renamed", 3);
    assert_eq!(renamed.diagnostics[0].fix.as_ref().unwrap().replacement, "size(\"a\").a.a.a");
    assert_eq!(nesting("shape", 3).diagnostics[0].range, check_support::range(41, 42));
    assert_eq!(nesting("shape", 4).diagnostics[0].range, check_support::range(52, 53));
    assert_eq!(nesting("formed", 4).diagnostics[0].fix.as_ref().unwrap().replacement, "[[[[\"a\".startsWith(\"b\")]]]]");
    let environment = deep_environment();
    for label in LABELS {
        for n in [3, 4] {
            assert_checks(&environment, label, &nesting(label, n));
        }
    }
}

#[test]
fn checks_and_fixes_each_construct_a_hundred_thousand_deep() {
    on_a_small_stack(|| {
        let environment = deep_environment();
        for label in LABELS {
            assert_checks(&environment, label, &nesting(label, DEEP));
        }
    });
}

#[test]
fn checks_a_hand_built_tree_a_hundred_thousand_deep() {
    on_a_small_stack(|| {
        let root: Arc<CelNode> = (0..DEEP).fold(support::literal_int(1, 0, 1), |operand, _| support::unary("-", operand, 0, 1));
        let expression = CelExpression { source: "".into(), root, namespaces: Arc::new(["Ns".to_string()]), diagnostic: None };
        let result = deep_environment().check_parsed(&expression).unwrap();
        assert_eq!((result.type_name.as_str(), result.diagnostics.len()), ("int", 0));
    });
}

/// `o` declared `optional<…<map<string, int>>>`, `n` optionals deep.
fn optionals(n: usize) -> CelEnvironment {
    let mut environment = CelEnvironment::new(CelEnvironmentOptions { enable_optional_types: true, ..Default::default() });
    let declared = (0..n).fold(telorun_cel::map_of(telorun_cel::STRING, telorun_cel::INT), |held, _| telorun_cel::optional_of(held));
    environment.register_variable("o", declared, None).unwrap();
    environment
}

/// Node's answers three and four optionals deep, which depth does not move.
fn optional_rows() -> Vec<check_support::Row> {
    vec![
        ("o.a", "optional<int>", vec![]),
        ("o[?'a']", "optional<int>", vec![]),
        ("has(o.a)", "bool", vec![]),
        ("o.a.b", "optional<dyn>", vec![found(TypeError, "int holds no members", 4, 5)]),
    ]
}

#[test]
fn reads_a_member_through_a_hundred_thousand_optionals() {
    for n in [3, 4] {
        check_support::assert_rows(&optionals(n), optional_rows());
    }
    on_a_small_stack(|| {
        let environment = optionals(DEEP);
        check_support::assert_rows(&environment, optional_rows());
        assert_eq!(
            environment.check("o").type_name,
            format!("{}map<string, int>{}", "optional<".repeat(DEEP), ">".repeat(DEEP))
        );
    });
}
