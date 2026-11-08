//! Twin of `templating/nodejs/tests/module-call.test.ts`, less its case reading the
//! dispatch key off the activation — the table is a typed argument here, so no source can
//! name it — plus the two dispatch facts that rest on a module function's failure ending
//! the evaluation, recorded by running the Node build at `1ba031dc` under Node v24.21.0.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use telo_templating::cel::analyze::extract_access_chains;
use telo_templating::cel::diagnose::audit_calls;
use telo_templating::cel::module_call::module_call_names;
use telo_templating::{
    analyze_cel_expression, build_cel_environment, compile_expression, namespace_dispatch_of, AnalyzeEnv, CallError,
    CelHandlers, ModuleCallDispatch, ModuleFunction,
};
use telorun_cel::{CelCallContext, CelEnvironment, NamespaceOptions, PropertyMap};
use telorun_cel_value::{cel_map_from_entries, CelRecord, CelValue};

fn cel_env() -> CelEnvironment {
    build_cel_environment(CelHandlers::default())
}

fn names() -> HashSet<String> {
    ["Billing", "Self", "Checkout", "Telo"].map(String::from).into()
}

/// A site's environment: the module's names as open namespaces.
fn site_env() -> CelEnvironment {
    let mut env = cel_env();
    for name in names() {
        env.register_namespace(&name, Vec::new(), NamespaceOptions { open: true }).unwrap();
    }
    env
}

fn s(text: &str) -> CelValue {
    CelValue::String(text.into())
}

fn record(entries: Vec<(&str, CelValue)>) -> CelValue {
    CelValue::Record(entries.into_iter().collect())
}

fn table(entries: Vec<(&str, ModuleFunction<String>)>) -> ModuleCallDispatch<String> {
    entries.into_iter().map(|(qualified, function)| (qualified.to_owned(), function)).collect()
}

fn function(answer: impl Fn(&[CelValue]) -> CelValue + Send + Sync + 'static) -> ModuleFunction<String> {
    Arc::new(move |args: &[CelValue]| Ok(answer(args)))
}

fn int(value: &CelValue) -> i64 {
    match value {
        CelValue::Int(held) => *held,
        other => panic!("not an int: {other:?}"),
    }
}

// --- resolution on the parsed tree ----------------------------------------------------

#[test]
fn carries_every_qualified_call_and_nothing_a_bare_name_reaches() {
    let env = cel_env();
    assert_eq!(compile_expression("Billing.format(x) + Self.y(1)", &env, Some(&names())).unwrap().calls(), ["Billing.format", "Self.y"]);
    assert!(compile_expression("format(1, ',d', 'en')", &env, Some(&names())).unwrap().calls().is_empty());
}

#[test]
fn leaves_the_authors_text_and_spans_untouched() {
    let source = "'x' + Billing.format(price)";
    let compiled = compile_expression(source, &cel_env(), Some(&names())).unwrap();
    assert_eq!(compiled.source(), source);
    let site = site_env();
    let names = names();
    let analysis = AnalyzeEnv { module_names: Some(&names), ..AnalyzeEnv::new(&site) };
    let calls = analyze_cel_expression(source, &analysis).calls;
    let resolved = calls.iter().find(|call| call.module_call).unwrap();
    assert_eq!(&source[resolved.start..resolved.end], "Billing.format(price)");
}

#[test]
fn is_a_call_on_a_bare_name_only() {
    assert!(module_call_names(&site_env().parse("a.Billing.format(x)").root).is_empty());
}

#[test]
fn carries_an_arguments_member_chain_but_not_one_rooted_at_a_name_the_expression_binds() {
    let source = "request.lines.map(item, Billing.total(item.net, request.rate))";
    let site = site_env();
    let names = names();
    let calls = analyze_cel_expression(source, &AnalyzeEnv { module_names: Some(&names), ..AnalyzeEnv::new(&site) }).calls;
    let call = calls.iter().find(|call| call.module_call).unwrap();
    let chains: Vec<Option<Vec<String>>> = call.arguments.as_ref().unwrap().iter().map(|argument| argument.chain.clone()).collect();
    assert_eq!(chains, [None, Some(vec!["request".to_string(), "rate".to_string()])]);
}

#[test]
fn keeps_the_receiver_out_of_the_access_chains_and_the_root_references() {
    assert_eq!(compile_expression("Billing.format(price.amount)", &cel_env(), Some(&names())).unwrap().refs(), ["price"]);
    let root = site_env().parse("Billing.format(price.amount)").root;
    assert_eq!(extract_access_chains(&root), [vec!["price".to_string(), "amount".to_string()]]);
}

// --- dispatch ---------------------------------------------------------------------

#[test]
fn fails_naming_the_qualified_function_when_nothing_bound_it() {
    let compiled = compile_expression("Billing.format(1)", &cel_env(), Some(&names())).unwrap();
    match compiled.call::<String>(&(), None) {
        Err(CallError::Templating(error)) => assert!(error.message.contains("unbound function 'Billing.format'"), "{}", error.message),
        other => panic!("answered {other:?}"),
    }
}

#[test]
fn dispatches_through_the_table_handed_beside_the_activation() {
    let compiled = compile_expression("Billing.format(1) + Self.y(2)", &cel_env(), Some(&names())).unwrap();
    let dispatch = table(vec![
        ("Billing.format", function(|args| s(&format!("#{}", int(&args[0]))))),
        ("Self.y", function(|args| s(&format!("!{}", int(&args[0]))))),
    ]);
    assert_eq!(compiled.call(&(), Some(&dispatch)).unwrap(), s("#1!2"));
}

#[test]
fn hands_a_module_function_its_arguments_in_the_form_a_host_holds_them() {
    let compiled = compile_expression("Self.seal({'query': 'q', 'page': 1}, [{'a': 2}])", &cel_env(), Some(&names())).unwrap();
    let seen: Arc<Mutex<Vec<CelValue>>> = Arc::default();
    let record_seen = Arc::clone(&seen);
    let dispatch = table(vec![(
        "Self.seal",
        function(move |args| {
            record_seen.lock().unwrap().extend(args.iter().cloned());
            s("ok")
        }),
    )]);
    assert_eq!(compiled.call(&(), Some(&dispatch)).unwrap(), s("ok"));
    let seen = seen.lock().unwrap();
    assert_eq!(
        *seen,
        [
            record(vec![("query", s("q")), ("page", CelValue::Int(1))]),
            CelValue::List(vec![record(vec![("a", CelValue::Int(2))])].into())
        ]
    );
    let CelValue::Record(first) = &seen[0] else { panic!("not the host form: {:?}", seen[0]) };
    assert_eq!(first.keys().collect::<Vec<_>>(), ["query", "page"]);
}

#[test]
fn reaches_the_table_through_a_comprehension_and_a_cel_bind_overlay() {
    let compiled = compile_expression("cel.bind(k, 2, items.map(i, Self.y(i + k)))", &cel_env(), Some(&names())).unwrap();
    let dispatch = table(vec![("Self.y", function(|args| CelValue::Int(int(&args[0]) * 10)))]);
    let activation: PropertyMap<CelValue> =
        [("items", CelValue::List(vec![CelValue::Int(1), CelValue::Int(2)].into()))].into_iter().collect();
    assert_eq!(
        compiled.call(&activation, Some(&dispatch)).unwrap(),
        CelValue::List(vec![CelValue::Int(30), CelValue::Int(40)].into())
    );
}

/// The module function's failure ends the evaluation, so `|| true` does not absorb it and
/// it keeps its own code — as Node answers, where it throws out.
#[test]
fn ends_the_evaluation_at_a_module_functions_failure_whatever_operator_surrounds_it() {
    for (source, expected) in [("Billing.refuse(2) || true", vec![2]), ("[1, 2].exists(x, Billing.refuse(x))", vec![1])] {
        let compiled = compile_expression(source, &cel_env(), Some(&names())).unwrap();
        let dispatched: Arc<Mutex<Vec<i64>>> = Arc::default();
        let record_dispatch = Arc::clone(&dispatched);
        let refuse: ModuleFunction<String> = Arc::new(move |args: &[CelValue]| {
            record_dispatch.lock().unwrap().push(int(&args[0]));
            Err("ERR_LEDGER_CLOSED".to_string())
        });
        let other_dispatch = Arc::clone(&dispatched);
        let total: ModuleFunction<String> = Arc::new(move |args: &[CelValue]| {
            other_dispatch.lock().unwrap().push(-1);
            Ok(args[0].clone())
        });
        let dispatch = table(vec![("Billing.refuse", refuse), ("Billing.total", total)]);
        match compiled.call(&(), Some(&dispatch)) {
            Err(CallError::Module(code)) => assert_eq!(code, "ERR_LEDGER_CLOSED", "{source}"),
            other => panic!("{source} answered {other:?}"),
        }
        assert_eq!(*dispatched.lock().unwrap(), expected, "{source}");
    }
}

// --- what the catalog says about a module call -----------------------------------------

#[test]
fn does_not_classify_a_module_call_against_the_catalog_and_attaches_no_catalog_flag() {
    let source = "Billing.format(1) + Checkout.now()";
    let env = site_env();
    let audit = audit_calls(source, &env.parse(source).root, &env, None, None);
    assert!(audit.diagnostics.is_empty());
    let calls: Vec<(&str, bool, Option<bool>)> =
        audit.calls.iter().map(|call| (call.name.as_str(), call.module_call, call.deterministic)).collect();
    assert_eq!(calls, [("Billing.format", true, None), ("Checkout.now", true, None)]);
}

// --- names a module call takes over ----------------------------------------------------

fn reserved(source: &str) -> Vec<&'static str> {
    let site = site_env();
    let names = names();
    analyze_cel_expression(source, &AnalyzeEnv { module_names: Some(&names), ..AnalyzeEnv::new(&site) })
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect()
}

#[test]
fn reserves_a_comprehension_variable_named_after_a_module() {
    assert_eq!(reserved("items.map(Billing, Billing + 1)").first(), Some(&"BINDING_NAME_RESERVED"));
}

#[test]
fn reserves_a_cel_bind_name_equal_to_a_module_name() {
    assert_eq!(reserved("cel.bind(Self, 3, Self + 1)").first(), Some(&"BINDING_NAME_RESERVED"));
}

fn unknown_identifier(source: &str) -> String {
    let mut env = cel_env();
    env.register_variable("variables", "map", None).unwrap();
    let names = names();
    let type_level = |name: &str| name.starts_with(|first: char| first.is_ascii_uppercase());
    let analysis = AnalyzeEnv {
        roots_declared: true,
        module_names: Some(&names),
        could_name_module: Some(&type_level),
        ..AnalyzeEnv::new(&env)
    };
    analyze_cel_expression(source, &analysis)
        .diagnostics
        .into_iter()
        .find(|diagnostic| diagnostic.code.as_str() == "CEL_UNKNOWN_IDENTIFIER")
        .expect("an unknown identifier")
        .message
}

#[test]
fn tells_an_undeclared_call_receiver_it_needs_an_imports_alias() {
    assert!(unknown_identifier("Unknown.bar(1)").contains("imports:"));
}

#[test]
fn withholds_that_advice_from_a_receiver_that_could_not_name_a_module() {
    assert!(!unknown_identifier("dbb.query(1)").contains("imports:"));
}

/// The adapter itself, and a compiled value through it: a map written at a call site
/// arrives as the host's record either way.
#[test]
#[allow(unused_variables)]
fn hands_a_module_function_plain_host_values_whichever_host_bound_the_table() {
    let direct: Arc<Mutex<Vec<CelValue>>> = Arc::default();
    let held = Arc::clone(&direct);
    let dispatch = table(vec![(
        "Billing.total",
        function(move |args| {
            held.lock().unwrap().extend(args.iter().cloned());
            CelValue::Int(1)
        }),
    )]);
    let bind = namespace_dispatch_of(Some(&dispatch)).unwrap();
    let implementation = bind("Billing", "total").unwrap();
    let map = CelValue::Map(cel_map_from_entries([(s("a"), CelValue::Int(1))]).unwrap());
    implementation(&CelCallContext::default(), &[map]).unwrap();

    let compiled_seen: Arc<Mutex<Vec<CelValue>>> = Arc::default();
    let held = Arc::clone(&compiled_seen);
    let dispatch = table(vec![(
        "Billing.total",
        function(move |args| {
            held.lock().unwrap().extend(args.iter().cloned());
            CelValue::Int(1)
        }),
    )]);
    compile_expression("Billing.total({'a': 1})", &cel_env(), Some(&names())).unwrap().call(&(), Some(&dispatch)).unwrap();

    for seen in [direct, compiled_seen] {
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(matches!(&seen[0], CelValue::Record(held) if *held == [("a", CelValue::Int(1))].into_iter().collect::<CelRecord>()));
    }
}

#[test]
fn binds_nothing_when_no_table_was_bound() {
    assert!(namespace_dispatch_of::<String>(None).is_none());
}
