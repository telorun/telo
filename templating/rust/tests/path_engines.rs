//! The path engines (`!include-text`, `!include-bytes`, `!module-path`) and the `!ref` engine,
//! against Node: what `analyze` reports for a written path, what `file_claims` claims and
//! what each produces.
//!
//! The table is recorded by running the Node engines at commit `2093db60` under Node
//! v24.21.0; each row is the engine, the source, the code and message of the one diagnostic
//! (none for a usable path) and the path claimed (none for an unusable one).

use serde_json::json;
use telo_templating::{
    build_cel_environment, default_registry, produced_type_of, AnalyzeEnv, CelHandlers, CompileEnv, CompileOutcome,
    TemplatingEngine, INCLUDE_TEXT,
};

/// engine, source, code, message, claimed path.
type Row = (&'static str, &'static str, Option<&'static str>, &'static str, Option<&'static str>);

const RECORDED: &[Row] = &[
    ("text", "", Some("INCLUDE_PATH_INVALID"), "the path is empty — name a location relative to the module root.", None),
    ("text", "https://x/a", Some("INCLUDE_PATH_INVALID"), "'https://x/a' names a location outside the module. An include path names what ships inside the module artifact, written relative to the module root. To read a file at runtime from somewhere else, use Fs.File.", None),
    ("text", "a/*.svg", Some("INCLUDE_PATH_INVALID"), "'a/*.svg' looks like a pattern. An include path names exactly one file, because publish places each claimed file into a layer by name.", None),
    ("text", "/etc/passwd", Some("INCLUDE_PATH_ESCAPES_MODULE"), "'/etc/passwd' is an absolute path. An include path is written relative to the module root, so the same manifest resolves identically from a checkout and from a published artifact.", None),
    ("text", "../x", Some("INCLUDE_PATH_ESCAPES_MODULE"), "'../x' points above the module root. An include path may only name what is inside the module, since that is the only thing its artifact can carry.", None),
    ("text", "a/../../x", Some("INCLUDE_PATH_ESCAPES_MODULE"), "'a/../../x' points above the module root. An include path may only name what is inside the module, since that is the only thing its artifact can carry.", None),
    ("text", "./", Some("INCLUDE_PATH_INVALID"), "'./' resolves to the module root itself, which is not exactly one file of it — name what inside it you mean.", None),
    ("text", "assets/./logo.svg", None, "", Some("assets/logo.svg")),
    ("bytes", "", Some("INCLUDE_PATH_INVALID"), "the path is empty — name a location relative to the module root.", None),
    ("bytes", "https://x/a", Some("INCLUDE_PATH_INVALID"), "'https://x/a' names a location outside the module. An include path names what ships inside the module artifact, written relative to the module root. To read a file at runtime from somewhere else, use Fs.File.", None),
    ("bytes", "a/*.svg", Some("INCLUDE_PATH_INVALID"), "'a/*.svg' looks like a pattern. An include path names exactly one file, because publish places each claimed file into a layer by name.", None),
    ("bytes", "/etc/passwd", Some("INCLUDE_PATH_ESCAPES_MODULE"), "'/etc/passwd' is an absolute path. An include path is written relative to the module root, so the same manifest resolves identically from a checkout and from a published artifact.", None),
    ("bytes", "../x", Some("INCLUDE_PATH_ESCAPES_MODULE"), "'../x' points above the module root. An include path may only name what is inside the module, since that is the only thing its artifact can carry.", None),
    ("bytes", "a/../../x", Some("INCLUDE_PATH_ESCAPES_MODULE"), "'a/../../x' points above the module root. An include path may only name what is inside the module, since that is the only thing its artifact can carry.", None),
    ("bytes", "./", Some("INCLUDE_PATH_INVALID"), "'./' resolves to the module root itself, which is not exactly one file of it — name what inside it you mean.", None),
    ("bytes", "assets/./logo.svg", None, "", Some("assets/logo.svg")),
    ("module", "", Some("MODULE_PATH_INVALID"), "the path is empty — name a location relative to the module root.", None),
    ("module", "https://x/a", Some("MODULE_PATH_INVALID"), "'https://x/a' names a location outside the module. A module path names what ships inside the module artifact, written relative to the module root. A location on the host is a Telo.HostPath value, read from a variable.", None),
    ("module", "a/*.svg", Some("MODULE_PATH_INVALID"), "'a/*.svg' looks like a pattern. A module path names one file or directory, because publish places each claimed file into a layer by name.", None),
    ("module", "/etc/passwd", Some("MODULE_PATH_ESCAPES_MODULE"), "'/etc/passwd' is an absolute path. A module path is written relative to the module root, so the same manifest resolves identically from a checkout and from a published artifact.", None),
    ("module", "../x", Some("MODULE_PATH_ESCAPES_MODULE"), "'../x' points above the module root. A module path may only name what is inside the module, since that is the only thing its artifact can carry.", None),
    ("module", "a/../../x", Some("MODULE_PATH_ESCAPES_MODULE"), "'a/../../x' points above the module root. A module path may only name what is inside the module, since that is the only thing its artifact can carry.", None),
    ("module", "./", Some("MODULE_PATH_INVALID"), "'./' resolves to the module root itself, which is not one file or directory of it — name what inside it you mean.", None),
    ("module", "assets/./logo.svg", None, "", Some("assets/logo.svg")),
];

fn engine_named(name: &str) -> &'static dyn TemplatingEngine {
    let tag = match name {
        "text" => "include-text",
        "bytes" => "include-bytes",
        "module" => "module-path",
        other => panic!("{other}"),
    };
    default_registry().get(tag).unwrap()
}

#[test]
fn reports_and_claims_as_node_does() {
    let env = build_cel_environment(CelHandlers::default());
    for (name, source, code, message, claim) in RECORDED {
        let engine = engine_named(name);
        let diagnostics = engine.analyze(source, &AnalyzeEnv::new(&env)).diagnostics;
        let reported: Vec<(Option<&str>, &str)> = diagnostics.iter().map(|d| (d.code.as_deref(), d.message.as_str())).collect();
        let expected: Vec<(Option<&str>, &str)> = code.map(|code| (Some(code), *message)).into_iter().collect();
        assert_eq!(reported, expected, "{name} {source:?}");
        let claims = engine.file_claims(source);
        assert_eq!(
            claims.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
            claim.iter().copied().collect::<Vec<_>>(),
            "{name} {source:?}"
        );
        assert!(claims.iter().all(|c| c.directory == (*name == "module")), "{name} {source:?}");
    }
}

#[test]
fn names_the_code_a_claim_that_names_nothing_is_reported_under() {
    let text = INCLUDE_TEXT.file_claims("./assets/bg.svg");
    assert_eq!((text[0].path.as_str(), text[0].not_found_code), ("assets/bg.svg", "INCLUDE_FILE_NOT_FOUND"));
    let module = default_registry().get("module-path").unwrap().file_claims("./public");
    assert_eq!((module[0].path.as_str(), module[0].directory, module[0].not_found_code), ("public", true, "MODULE_PATH_NOT_FOUND"));
}

#[test]
fn produces_what_the_tag_always_produces() {
    assert_eq!(produced_type_of("include-text"), Some(json!({ "type": "string" })));
    assert_eq!(produced_type_of("include-bytes"), Some(json!({ "x-telo-type": "Telo.Bytes" })));
    assert_eq!(produced_type_of("module-path"), Some(json!({ "type": "string", "x-telo-type": "Telo.HostPath" })));
    assert_eq!(produced_type_of("cel"), None);
    assert_eq!(produced_type_of("ref"), None);
    assert_eq!(produced_type_of("no-such-tag"), None);
}

#[test]
fn leaves_the_marker_for_whoever_reads_it() {
    let env = build_cel_environment(CelHandlers::default());
    for tag in ["include-text", "include-bytes", "module-path", "ref"] {
        let outcome = default_registry().get(tag).unwrap().compile("assets/a", &CompileEnv { cel_env: &env, module_names: None });
        assert!(matches!(outcome, Ok(CompileOutcome::Unchanged)), "{tag}");
    }
    assert!(default_registry().get("ref").unwrap().analyze("x", &AnalyzeEnv::new(&env)).diagnostics.is_empty());
}
