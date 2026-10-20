//! Compiling and evaluating recurse with nothing: a tree a hundred thousand deep is
//! compiled, evaluated and released on a stack of 256 KiB, in a debug build — every
//! construct whose nesting nests a program: operators, `&&` and `||` both ways round, the
//! conditional, aggregates, a call, a namespaced call, `cel.bind`, each comprehension and
//! a member chain.
//!
//! No Node test file is the twin of this one, and every answer here is this crate's own:
//! Node's closure backend recurses with the tree, compiling and evaluating, and throws
//! `RangeError` on these trees. What each answers is the answer the same construct three
//! deep gives, carried to its depth.

mod support;
mod value_support;

use std::sync::Arc;

use support::{binary, literal_bool};
use telorun_cel::{
    CelCallContext, CelEnvironment, CelEnvironmentOptions, CelExpression, CelImplementation, CelParseLimits, CelValue,
    EvaluateOptions, NamespaceOptions, PropertyMap,
};
use value_support::{i, rec};

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
        enable_optional_types: true,
        limits: CelParseLimits { max_nodes: 10 * DEEP, max_depth: 10 * DEEP, ..Default::default() },
        ..Default::default()
    });
    environment.register_namespace("Ns", vec!["f(int): int".into()], NamespaceOptions::default()).unwrap();
    environment
}

fn evaluated(source: &str, activation: &PropertyMap<CelValue>) -> CelValue {
    let environment = deep_environment();
    let program = environment.compile(source).unwrap_or_else(|refused| panic!("{refused}"));
    program.evaluate(activation, &EvaluateOptions::default()).unwrap_or_else(|failed| panic!("{failed:?}"))
}

/// How many lists deep a value is, read without recursion.
fn list_depth(value: &CelValue) -> usize {
    let mut depth = 0;
    let mut at = value;
    while let CelValue::List(items) = at {
        depth += 1;
        at = &items[0];
    }
    depth
}

#[test]
fn evaluates_operators_a_hundred_thousand_deep() {
    on_a_small_stack(|| {
        let none = PropertyMap::new();
        assert_eq!(evaluated(&format!("{}true", "!".repeat(DEEP)), &none), CelValue::Bool(true));
        assert_eq!(evaluated(&format!("1{}", " + 1".repeat(DEEP)), &none), i(DEEP as i64 + 1));
        assert_eq!(
            evaluated(&format!("{}1{}", "true ? ".repeat(DEEP), " : 2".repeat(DEEP)), &none),
            i(1)
        );
        assert_eq!(evaluated(&format!("{}1{}", "size([".repeat(DEEP), "])".repeat(DEEP)), &none), i(1));
    });
}

#[test]
fn evaluates_chains_of_and_and_or_a_hundred_thousand_long_either_way_round() {
    on_a_small_stack(|| {
        let none = PropertyMap::new();
        // A missing key at the head of the chain, beaten by a decided operand at its end.
        assert_eq!(
            evaluated(&format!("{{'a': 1}}.b == 1{} && false", " && true".repeat(DEEP)), &none),
            CelValue::Bool(false)
        );
        assert_eq!(
            evaluated(&format!("{{'a': 1}}.b == 1{} || true", " || false".repeat(DEEP)), &none),
            CelValue::Bool(true)
        );
        // Right-nested, which no source reads as: a hand-built tree.
        let mut tree = literal_bool(true, 0, 4);
        for _ in 0..DEEP {
            tree = binary("&&", literal_bool(true, 0, 4), tree, 0, 4);
        }
        let expression =
            CelExpression { source: "true".into(), root: tree, namespaces: vec!["Ns".to_string()].into(), diagnostic: None };
        let environment = deep_environment();
        let program = environment.compile_parsed(&expression).unwrap();
        assert_eq!(program.evaluate(&(), &EvaluateOptions::default()), Ok(CelValue::Bool(true)));
    });
}

#[test]
fn evaluates_aggregates_a_hundred_thousand_deep() {
    on_a_small_stack(|| {
        let none = PropertyMap::new();
        let lists = evaluated(&format!("{}1{}", "[".repeat(DEEP), "]".repeat(DEEP)), &none);
        assert_eq!(list_depth(&lists), DEEP);
        let maps = evaluated(&format!("{}1{}['k']", "{'k': ".repeat(DEEP), "}".repeat(DEEP)), &none);
        let CelValue::Map(_) = maps else { panic!("a map") };
    });
}

#[test]
#[allow(unused_variables)]
fn evaluates_calls_and_namespaced_calls_a_hundred_thousand_deep() {
    on_a_small_stack(|| {
        let none = PropertyMap::new();
        assert_eq!(evaluated(&format!("{}1{}", "int(".repeat(DEEP), ")".repeat(DEEP)), &none), i(1));
        let next: CelImplementation = Arc::new(|context: &CelCallContext, args: &[CelValue]| match args {
            [CelValue::Int(held)] => i(held + 1),
            _ => unreachable!("Ns.f is handed an int"),
        });
        let bind = |namespace: &str, name: &str| Some(Arc::clone(&next));
        let environment = deep_environment();
        let program = environment.compile(&format!("{}0{}", "Ns.f(".repeat(DEEP), ")".repeat(DEEP))).unwrap();
        assert_eq!(program.evaluate(&(), &EvaluateOptions { namespace_function: Some(&bind) }), Ok(i(DEEP as i64)));
    });
}

#[test]
fn evaluates_bindings_and_comprehensions_a_hundred_thousand_deep() {
    on_a_small_stack(|| {
        let none = PropertyMap::new();
        assert_eq!(
            evaluated(&format!("cel.bind(x, 0, {}x{})", "cel.bind(x, x + 1, ".repeat(DEEP), ")".repeat(DEEP)), &none),
            i(DEEP as i64)
        );
        assert_eq!(
            evaluated(&format!("{}x == 1{}", "[1].all(x, ".repeat(DEEP), ")".repeat(DEEP)), &none),
            CelValue::Bool(true)
        );
        assert_eq!(
            evaluated(&format!("{}x == 1{}", "[1].exists(x, ".repeat(DEEP), ")".repeat(DEEP)), &none),
            CelValue::Bool(true)
        );
        let maps = evaluated(&format!("{}x{}", "[1].map(x, ".repeat(DEEP), ")".repeat(DEEP)), &none);
        assert_eq!(list_depth(&maps), DEEP);
        let filtered = evaluated(&format!("{}[x]{}", "[1].filter(x, ".repeat(DEEP), ".size() == 1)".repeat(DEEP)), &none);
        assert_eq!(filtered, CelValue::List(vec![i(1)].into()));
    });
}

#[test]
fn evaluates_a_member_chain_a_hundred_thousand_long() {
    on_a_small_stack(|| {
        let mut nested = i(1);
        for _ in 0..DEEP {
            nested = rec(vec![("a", nested)]);
        }
        let activation: PropertyMap<CelValue> = [("m", nested)].into_iter().collect();
        // Rooted at a name a comprehension bound, so every member is read off the value.
        assert_eq!(
            evaluated(&format!("[m].all(v, v{} == 1)", ".a".repeat(DEEP)), &activation),
            CelValue::Bool(true)
        );
        assert_eq!(
            evaluated(&format!("[m].all(v, v{}.?a.orValue(2) == 2)", ".a".repeat(DEEP)), &activation),
            CelValue::Bool(true)
        );
    });
}
