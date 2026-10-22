//! The compiled program's own properties: how a namespaced call is dispatched, every
//! refusal of a compile — a tree that cannot be compiled, a source that did not read, a
//! tree resolved under another namespace set — the capacity of every cache it keeps, and
//! one program evaluated on many threads at once.
//!
//! The first and the capacities are the twin of `cel/nodejs/tests/closure-backend.test.ts`,
//! less its case reading the source for `eval`, which is about JavaScript. Every expected
//! answer and message is what the Node build answered, executed —
//! `@telorun/cel 0.120.1 at b4a2b6e9`; concurrency is this crate's own.

mod evaluation_support;
mod value_support;

use std::sync::{Arc, Mutex};

use evaluation_support::{answer, bindings, language, loose, program_answer};
use telorun_cel::{
    CelBinaryNode, CelBinaryOperator, CelCallContext, CelEngineErrorCode, CelEnvironment, CelEnvironmentOptions,
    CelExpression, CelImplementation, CelLiteral, CelLiteralNode, CelNode, CelProgramError, CelReceiverCallNode,
    CelUnparsedNode, CelValue, EvaluateOptions, NamespaceOptions, SourceRange, CALL_SITE_CACHE_CAPACITY,
    DEFAULT_COMPILED_CACHE_CAPACITY, PATTERN_CACHE_CAPACITY,
};
use value_support::{by, d, i, l, s};

fn billing() -> CelEnvironment {
    let mut environment = loose();
    environment.register_namespace("Billing", vec!["total(int, int): int".into()], NamespaceOptions::default()).unwrap();
    environment
}

#[test]
#[allow(unused_variables)]
fn dispatches_a_namespaced_call_through_what_the_host_bound_and_fails_where_nothing_did() {
    let environment = billing();
    let program = environment.compile("Billing.total(2, 3) + 1").unwrap();
    let dispatched: Arc<Mutex<Vec<Vec<CelValue>>>> = Arc::default();
    let seen = Arc::clone(&dispatched);
    let total: CelImplementation = Arc::new(move |context: &CelCallContext, args: &[CelValue]| {
        seen.lock().unwrap().push(args.to_vec());
        match args {
            [CelValue::Int(a), CelValue::Int(b)] => CelValue::Int(a * b),
            _ => unreachable!("the call hands two ints"),
        }
    });
    let bind = |namespace: &str, name: &str| (namespace == "Billing" && name == "total").then(|| Arc::clone(&total));
    let answered = program.evaluate(&(), &EvaluateOptions { namespace_function: Some(&bind) });
    assert_eq!(answered, Ok(i(7)));
    assert_eq!(*dispatched.lock().unwrap(), vec![vec![i(2), i(3)]]);
    assert_eq!(
        program_answer(&program, &()),
        "error unbound_function [0, 19] unbound function 'Billing.total' — nothing is bound under that name here"
    );
}

#[test]
#[allow(unused_variables)]
fn decides_an_unbound_namespaced_call_before_evaluating_any_argument() {
    let environment = billing();
    let one: CelImplementation = Arc::new(|context: &CelCallContext, args: &[CelValue]| i(1));
    let bind = |namespace: &str, name: &str| Some(Arc::clone(&one));
    let bound = EvaluateOptions { namespace_function: Some(&bind) };
    let run = |source: &str, options: &EvaluateOptions<'_>| answer(environment.evaluate(source, &(), options));
    assert_eq!(
        run("Billing.total(1 / 0, 2)", &EvaluateOptions::default()),
        "error unbound_function [0, 23] unbound function 'Billing.total' — nothing is bound under that name here"
    );
    assert_eq!(run("Billing.total(1 / 0, 2)", &bound), "error division_by_zero [14, 19] division by zero");
    assert_eq!(run("Billing.total(2, 1 / 0)", &bound), "error division_by_zero [17, 22] division by zero");
}

#[test]
fn declares_the_capacity_of_every_cache_it_keeps() {
    assert_eq!((CALL_SITE_CACHE_CAPACITY, DEFAULT_COMPILED_CACHE_CAPACITY, PATTERN_CACHE_CAPACITY), (16, 256, 128));
    assert_eq!(CelEnvironmentOptions::default().compiled_cache_capacity.get(), DEFAULT_COMPILED_CACHE_CAPACITY);
}

fn refusal(result: Result<Arc<telorun_cel::CelProgram>, CelProgramError>) -> String {
    match result {
        Ok(_) => "compiled".into(),
        Err(CelProgramError::Compile(error)) => format!("CelCompileError: {}", error.message),
        Err(CelProgramError::Engine(error)) => format!("CelEngineError {}: {}", error.code.as_str(), error.message),
    }
}

#[test]
fn refuses_each_tree_no_evaluation_can_be_compiled_from_with_nodes_message() {
    let environment = language();
    for (source, expected) in [
        ("has(a)", "CelCompileError: has() asks about a member, so its argument ends in a select"),
        ("has(a[0])", "CelCompileError: has() asks about a member, so its argument ends in a select"),
        ("cel.bind(x, 1)", "CelCompileError: cel.bind(name, value, body) takes a name, its value and a body"),
        ("cel.bind(1, 2, 3)", "CelCompileError: cel.bind binds a name"),
        ("cel.bind(x.y, 2, 3)", "CelCompileError: cel.bind binds a name"),
        ("optional.of()", "CelCompileError: optional.of(value) takes one argument"),
        ("optional.of(1, 2)", "CelCompileError: optional.of(value) takes one argument"),
        ("optional.ofNonZeroValue()", "CelCompileError: optional.ofNonZeroValue(value) takes one argument"),
        ("o.optMap(1, 2)", "CelCompileError: optMap binds a name"),
        ("o.optFlatMap(x.y, 2)", "CelCompileError: optFlatMap binds a name"),
        ("[1].map(1, 2)", "CelCompileError: map binds a name"),
        ("[1].all(1, true)", "CelCompileError: all binds a name"),
        ("[1].map(f(), true, 2)", "CelCompileError: map binds a name"),
        // The first refusal in the compiler's own order: an outer macro's shape before
        // anything inside it, and siblings left to right.
        ("has(x.y) && cel.bind(1, 2, 3)", "CelCompileError: cel.bind binds a name"),
        ("cel.bind(1, has(a), 3)", "CelCompileError: cel.bind binds a name"),
        ("[has(a), cel.bind(x, 1)]", "CelCompileError: has() asks about a member, so its argument ends in a select"),
    ] {
        assert_eq!(refusal(environment.compile(source)), expected, "{source}");
    }
}

#[test]
fn refuses_a_source_that_did_not_read_whole_and_a_tree_resolved_under_another_namespace_set() {
    let environment = language();
    assert_eq!(
        refusal(environment.compile("1 +")),
        "CelEngineError unreadable_expression: \"1 +\" could not be read: the expression ends before it is complete"
    );
    assert_eq!(
        refusal(environment.compile("[1, 2")),
        "CelEngineError unreadable_expression: \"[1, 2\" could not be read: the expression ends before it is complete, expected \"]\""
    );
    let read_elsewhere = billing().parse("Billing.total(1)");
    assert_eq!(
        refusal(environment.compile_parsed(&read_elsewhere)),
        "CelEngineError namespaces_mismatch: the expression was resolved under [Billing] and this environment has []"
    );
    let mut two = CelEnvironment::default();
    two.register_namespace("A", vec![], NamespaceOptions::default()).unwrap();
    two.register_namespace("B", vec![], NamespaceOptions::default()).unwrap();
    let refused = two.compile_parsed(&environment.parse("1"));
    assert!(matches!(&refused, Err(CelProgramError::Engine(error)) if error.code == CelEngineErrorCode::NamespacesMismatch));
    assert_eq!(
        refusal(refused),
        "CelEngineError namespaces_mismatch: the expression was resolved under [] and this environment has [A, B]"
    );
}

#[test]
fn refuses_a_hand_built_tree_holding_a_hole_no_diagnostic_reports() {
    let range = |start, end| SourceRange { start, end };
    let hole = Arc::new(CelNode::Unparsed(CelUnparsedNode { range: range(4, 4) }));
    let expression = CelExpression {
        source: "1 + ".into(),
        root: Arc::new(CelNode::Binary(CelBinaryNode {
            operator: CelBinaryOperator::Add,
            left: Arc::new(CelNode::Literal(CelLiteralNode { literal: CelLiteral::Int(1), range: range(0, 1) })),
            right: Arc::clone(&hole),
            range: range(0, 4),
        })),
        namespaces: Vec::new().into(),
        diagnostic: None,
    };
    let environment = CelEnvironment::new(CelEnvironmentOptions { enable_optional_types: true, ..Default::default() });
    assert_eq!(
        refusal(environment.compile_parsed(&expression)),
        "CelCompileError: the expression could not be read whole, so it cannot be compiled"
    );
    // `optional.none` compiles none of its arguments, so a hole there is never reached.
    let none = environment.parse("optional.none(1)");
    let CelNode::ReceiverCall(call) = &*none.root else { panic!("a receiver call") };
    let with_hole = CelExpression {
        root: Arc::new(CelNode::ReceiverCall(CelReceiverCallNode { args: vec![hole], ..call.clone() })),
        ..none.clone()
    };
    let program = environment.compile_parsed(&with_hole).unwrap();
    assert_eq!(program_answer(&program, &()), "value optional()");
}

#[test]
fn evaluates_one_program_on_eight_threads_at_once_alike() {
    // A comprehension, a polymorphic site whose types differ by thread, and a call the
    // standard library answers — each thread's answers held to one thread's.
    let environment = language();
    let program = environment.compile("[dyn(v) + dyn(v)].map(x, [x, size(name)]).filter(y, size(y) == 2)").unwrap();
    let values = [i(3), s("ab"), d(2.5), l(vec![i(1)]), by(b"xy"), i(-4), s(""), d(0.5)];
    let expected = [
        "value list(list(int 6, int 4))",
        "value list(list(string \"abab\", int 4))",
        "value list(list(double 5, int 4))",
        "value list(list(list(int 1, int 1), int 4))",
        "value list(list(bytes 78797879, int 4))",
        "value list(list(int -8, int 4))",
        "value list(list(string \"\", int 4))",
        "value list(list(double 1, int 4))",
    ];
    let answered: Vec<Vec<String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|thread| {
                let program = &program;
                let values = &values;
                scope.spawn(move || {
                    (0..500)
                        .map(|round| {
                            let value = &values[(thread + round) % values.len()];
                            program_answer(program, &bindings(vec![("v", value.clone()), ("name", s("name"))]))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap()).collect()
    });
    for (thread, answers) in answered.iter().enumerate() {
        for (round, held) in answers.iter().enumerate() {
            assert_eq!(held, expected[(thread + round) % values.len()], "thread {thread}, round {round}");
        }
    }
}
