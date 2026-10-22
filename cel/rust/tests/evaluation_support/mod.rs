//! Evaluating an expression and writing what it answered, one way — the twin of the
//! `written` and `answerText` helpers of `cel/nodejs/tests/emitted-host.ts`, with an
//! error's message written after its range. Every expected answer in the tables that read
//! it is what the Node build answered, written by the same rules.

#![allow(dead_code)]

use telorun_cel::{
    double_text, is_identifier_spelling, CelActivation, CelEnvironment, CelEnvironmentOptions, CelEvaluateError,
    CelProgram, CelValue, EvaluateOptions, FunctionDefinition, PropertyMap,
};
use telorun_cel_value::{format_duration, format_timestamp, json_quote};

/// The environment the Node tests mostly evaluate in: unlisted names `dyn`, optional types on.
pub fn language() -> CelEnvironment {
    CelEnvironment::new(CelEnvironmentOptions {
        unlisted_variables_are_dyn: true,
        enable_optional_types: true,
        ..Default::default()
    })
}

/// Unlisted names `dyn`, and nothing else turned on.
pub fn loose() -> CelEnvironment {
    CelEnvironment::new(CelEnvironmentOptions { unlisted_variables_are_dyn: true, ..Default::default() })
}

/// An activation of the names given.
pub fn bindings(pairs: Vec<(&str, CelValue)>) -> PropertyMap<CelValue> {
    pairs.into_iter().collect()
}

/// What an evaluation answered.
pub fn evaluate(environment: &CelEnvironment, source: &str, activation: &dyn CelActivation) -> CelValue {
    environment
        .evaluate(source, activation, &EvaluateOptions::default())
        .unwrap_or_else(|failed| panic!("{source} answered no value: {failed:?}"))
}

/// The code of the error an evaluation failed with.
pub fn failure(environment: &CelEnvironment, source: &str, activation: &dyn CelActivation) -> &'static str {
    match environment.evaluate(source, activation, &EvaluateOptions::default()) {
        Err(CelEvaluateError::Evaluation(error)) => error.code.as_str(),
        other => panic!("{source} did not fail at evaluation: {other:?}"),
    }
}

/// `value <written>`, `error <code> [<start>, <end>] <message>`, or `threw <class>: <message>`.
pub fn answer(result: Result<CelValue, CelEvaluateError>) -> String {
    match result {
        Ok(value) => format!("value {}", written(&value)),
        Err(CelEvaluateError::Evaluation(error)) => format!(
            "error {} [{}] {}",
            error.code.as_str(),
            error.range.map_or("-".into(), |range| format!("{}, {}", range.start, range.end)),
            error.message
        ),
        Err(CelEvaluateError::Engine(error)) => format!("threw CelEngineError: {}", error.message),
        Err(CelEvaluateError::Compile(error)) => format!("threw CelCompileError: {}", error.message),
    }
}

/// What a program answers, written.
pub fn program_answer(program: &CelProgram, activation: &dyn CelActivation) -> String {
    answer(program.evaluate(activation, &EvaluateOptions::default()).map_err(CelEvaluateError::Evaluation))
}

/// What a source answers in an environment, written.
pub fn source_answer(environment: &CelEnvironment, source: &str, activation: &dyn CelActivation) -> String {
    answer(environment.evaluate(source, activation, &EvaluateOptions::default()))
}

/// Every value written one way, as Node's `written` writes it.
pub fn written(value: &CelValue) -> String {
    match value {
        CelValue::Null => "null".into(),
        CelValue::Bool(held) => format!("bool {held}"),
        CelValue::String(held) => format!("string {}", json_quote(held)),
        CelValue::Double(held) => format!("double {}", double_text(*held)),
        CelValue::Int(held) => format!("int {held}"),
        CelValue::Uint(held) => format!("uint {held}"),
        CelValue::Timestamp(held) => format!("timestamp {}", format_timestamp(*held)),
        CelValue::Duration(held) => format!("duration {}", format_duration(*held)),
        CelValue::Type(held) => format!("type {}", held.name()),
        CelValue::Optional(held) => match held.held() {
            Some(held) => format!("optional({})", written(held)),
            None => "optional()".into(),
        },
        CelValue::Error(error) => format!(
            "error {} [{}]",
            error.code.as_str(),
            error.range.map_or("-".into(), |range| format!("{}, {}", range.start, range.end))
        ),
        CelValue::Bytes(held) => format!("bytes {}", held.iter().map(|byte| format!("{byte:02x}")).collect::<String>()),
        CelValue::List(items) => format!("list({})", items.iter().map(written).collect::<Vec<_>>().join(", ")),
        CelValue::Map(map) => format!(
            "map({})",
            map.iter().map(|(key, value)| format!("{}: {}", written(key), written(value))).collect::<Vec<_>>().join(", ")
        ),
        CelValue::Record(record) => format!(
            "record({})",
            record.iter().map(|(key, value)| format!("{key}: {}", written(value))).collect::<Vec<_>>().join(", ")
        ),
        CelValue::Host(_) => "host [object Object]".into(),
    }
}

// --- Node's registry-call generator (`cel/nodejs/tests/registry-calls.ts`) ---------------

/// One value of each type the registrations are written over — Node's `SAMPLES`.
pub fn sample(ty: &str) -> &'static str {
    match ty {
        "bool" => "true",
        "bytes" => "b'ab'",
        "double" => "2.5",
        "int" => "3",
        "uint" => "3u",
        "string" => "'ab'",
        "null" => "null",
        "type" => "int",
        "dyn" => "dyn(2.5)",
        "google.protobuf.Timestamp" => "timestamp('2024-03-04T05:06:07.008009010Z')",
        "google.protobuf.Duration" => "duration('90.5s')",
        "list<A>" | "list<dyn>" => "[1, 2]",
        "list<string>" => "['a', 'b']",
        "map<K, V>" | "map<dyn, dyn>" => "{'a': 1}",
        "optional<A>" => "optional.of(1)",
        "A" => "1",
        "K" => "'a'",
        other => panic!("no sample value for the type {other:?}"),
    }
}

/// Node's `callSource`: an operator in operator syntax, a volatile call inside `type(…)`.
pub fn call_source(held: &FunctionDefinition) -> String {
    let args: Vec<&str> = held.parameters.iter().map(|ty| sample(ty)).collect();
    let call = match &held.receiver_type {
        Some(receiver) => format!("({}).{}({})", sample(receiver), held.name, args.join(", ")),
        None => {
            let infix = held.name == "in" || !is_identifier_spelling(&held.name);
            if !infix {
                format!("{}({})", held.name, args.join(", "))
            } else if args.len() == 1 {
                format!("{}({})", held.name, args[0])
            } else {
                format!("({}) {} ({})", args[0], held.name, args[1])
            }
        }
    };
    if held.deterministic {
        call
    } else {
        format!("type({call})")
    }
}
