//! What no check-conformance row can hold: a refusal prints the diagnostics it carries, and a
//! construct only this kernel cannot read is its own refusal, ahead of every other.

use std::path::Path;

use telo_kernel::{Kernel, KernelError};

fn load(files: &[(&str, &str)]) -> (tempfile::TempDir, KernelError) {
    let dir = tempfile::tempdir().expect("temp dir");
    for (path, text) in files {
        let path = dir.path().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).expect("create dir");
        std::fs::write(path, text).expect("write manifest");
    }
    let entry = dir.path().join("app/telo.yaml");
    let err = Kernel::new().load(&entry.display().to_string()).expect_err("load must fail");
    (dir, err)
}

fn source(dir: &Path, path: &str) -> String {
    dir.join(path).display().to_string()
}

/// The refusal names its cause wherever it is written, not its headline alone.
#[test]
fn a_refusal_prints_the_diagnostics_it_carries() {
    let (_dir, err) = load(&[
        ("app/telo.yaml", "kind: Telo.Application\nmetadata: { name: App }\nimports: { Lib: ../lib }\n"),
        (
            "lib/telo.yaml",
            "kind: Telo.Library\nmetadata: { name: CapLib }\n---\nkind: Telo.Definition\nmetadata: { name: Misspelled }\ncapability: Telo.Invokable\n",
        ),
    ]);
    assert!(
        err.to_string().starts_with(
            "[ERR_MANIFEST_VALIDATION_FAILED] Manifest validation failed\n  [CAPABILITY_UNKNOWN] Imported library 'CapLib'"
        ),
        "{err}"
    );
}

#[test]
fn a_construct_this_kernel_cannot_read_is_refused_first() {
    let (dir, err) = load(&[(
        "app/telo.yaml",
        "kind: Telo.Application\nmetadata: { name: App }\nname: 1\nname: 2\n---\nkind: Thing\nvalue: !cel \"1 + 1\"\n---\nkind: Thing\nvalue: !nope x\n",
    )]);
    assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE", "{err}");
    assert_eq!(
        err.message,
        format!(
            "'{}', document 3, line 10, column 14: unsupported YAML tag `!nope`; this kernel recognises: !cel, !include-bytes, !include-text, !interpolate, !literal, !module-path, !ref, !sql",
            source(dir.path(), "app/telo.yaml")
        )
    );
    assert!(err.diagnostics.is_empty());
}

fn console() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../modules/console").display().to_string()
}

fn app(rest: &str) -> String {
    format!("kind: Telo.Application\nmetadata: {{ name: App }}\n{rest}")
}

const NO_ENGINE: &str = "and this kernel has no expression engine";

/// A resource is refused where it is created.
#[test]
fn a_resource_holding_an_expression_is_refused_at_creation() {
    let text = app(&format!(
        "imports: {{ Console: {} }}\n---\nkind: Console.WriteLine\nmetadata: {{ name: w }}\noutput: !cel \"'x'\"\n",
        console()
    ));
    let (_dir, err) = load(&[("app/telo.yaml", &text)]);
    assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE", "{err}");
    assert_eq!(err.message, format!("Console.WriteLine/w: field `output` holds `!cel`, {NO_ENGINE}"));
}

/// A kind document is refused at registration, a schema keyword included.
#[test]
fn a_kind_document_holding_an_expression_is_refused_at_registration() {
    let (_dir, err) = load(&[
        ("app/telo.yaml", &app("imports: { Lib: ../lib }\n")),
        (
            "lib/telo.yaml",
            "kind: Telo.Library\nmetadata: { name: Lib }\n---\nkind: Telo.Definition\nmetadata: { name: Thing }\ncapability: Telo.Invocable\nschema:\n  type: object\n  properties:\n    a: { default: !interpolate \"p ${{ 1 }}\" }\n",
        ),
    ]);
    assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE", "{err}");
    assert_eq!(
        err.message,
        format!("Telo.Definition/Thing: field `schema.properties.a.default` holds `!interpolate`, {NO_ENGINE}")
    );
}

#[test]
fn a_module_doc_field_holding_an_expression_is_refused() {
    let (_dir, err) = load(&[("app/telo.yaml", &app("lang: !cel \"'en'\"\n"))]);
    assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE", "{err}");
    assert_eq!(err.message, format!("Telo.Application/App: field `lang` holds `!cel`, {NO_ENGINE}"));
}

#[test]
fn an_import_supplying_an_expression_is_refused() {
    let (_dir, err) = load(&[
        ("app/telo.yaml", &app("imports:\n  Lib: { source: ../lib, variables: { x: !sql \"SELECT ${{ 1 }}\" } }\n")),
        ("lib/telo.yaml", "kind: Telo.Library\nmetadata: { name: Lib }\n"),
    ]);
    assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE", "{err}");
    assert_eq!(
        err.message,
        format!("Telo.Application/App: field `imports.Lib.variables.x` holds `!sql`, {NO_ENGINE}")
    );
}

/// A target is consumed when it runs, so the load goes through and the run refuses.
#[test]
fn a_target_holding_an_expression_is_refused_when_it_runs() {
    let dir = tempfile::tempdir().expect("temp dir");
    let entry = dir.path().join("telo.yaml");
    std::fs::write(
        &entry,
        app(&format!(
            "imports: {{ Console: {} }}\ntargets:\n  - invoke: !ref Console.writeLine\n    inputs: {{ output: !cel \"'x'\" }}\n",
            console()
        )),
    )
    .expect("write manifest");
    let mut kernel = Kernel::new();
    kernel.load(&entry.display().to_string()).expect("the load consumes no target");
    let err = kernel.run_targets().expect_err("the target is refused");
    assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE", "{err}");
    assert_eq!(
        err.message,
        format!("Telo.Application/App: field `targets[0].inputs.output` holds `!cel`, {NO_ENGINE}")
    );
}

/// A nested declaration is its own to refuse when it is created, so the declaring
/// resource's creation does not read it: what stops this load is the schema, not an engine.
#[test]
fn an_expression_inside_a_nested_declaration_is_not_read() {
    let text = app(&format!(
        "imports: {{ Console: {} }}\n---\nkind: Console.WriteLine\nmetadata: {{ name: w }}\nnested: {{ kind: Console.Write, output: !cel \"'x'\" }}\n",
        console()
    ));
    let (_dir, err) = load(&[("app/telo.yaml", &text)]);
    assert!(!err.to_string().contains(NO_ENGINE), "{err}");
}

/// A kind taking one string field, which no controller backs: a `!literal` that reached
/// schema validation as text passes it and fails later, one that stayed a marker fails it.
fn string_field_app(value: &str) -> String {
    app(&format!(
        "imports: {{ Lib: ../lib }}\n---\nkind: Lib.Thing\nmetadata: {{ name: t }}\ntext: {value}\n"
    ))
}

const THING_LIBRARY: &str = "kind: Telo.Library\nmetadata: { name: Lib }\nexports: { kinds: [Thing] }\n---\nkind: Telo.Definition\nmetadata: { name: Thing }\ncapability: Telo.Invocable\nschema:\n  type: object\n  properties:\n    text: { type: string }\n  required: [text]\n  additionalProperties: false\n";

#[test]
fn a_literal_reaches_schema_validation_as_its_text() {
    let (_dir, err) = load(&[
        ("app/telo.yaml", &string_field_app("!literal \"${{ not an expression }}\"")),
        ("lib/telo.yaml", THING_LIBRARY),
    ]);
    assert!(!err.to_string().contains("is invalid"), "{err}");
    let (_dir, err) = load(&[("app/telo.yaml", &string_field_app("7")), ("lib/telo.yaml", THING_LIBRARY)]);
    assert!(err.to_string().contains("is invalid"), "{err}");
}

/// What the load's analysis leaves — a library's own string holding a `${{` no hole can be
/// read out of — is refused where the kernel consumes it, in the words of Node's backstop.
#[test]
fn a_plain_string_left_holding_an_interpolation_is_refused_where_it_is_consumed() {
    let (dir, err) = load(&[
        ("app/telo.yaml", &string_field_app("ok")),
        (
            "lib/telo.yaml",
            &format!("{THING_LIBRARY}---\nkind: Self.Thing\nmetadata: {{ name: priced }}\ntext: \"costs ${{{{ 5\"\n"),
        ),
    ]);
    assert_eq!(err.code, "ERR_UNTAGGED_INTERPOLATION", "{err}");
    assert_eq!(
        err.message,
        format!(
            "Failed to compile manifest in {}: 'text' is a plain string holding '${{{{', which is never evaluated. Untagged interpolation is a legacy spelling the 'untagged-interpolation' migration rewrites (a lone hole to !cel, text with holes to !interpolate); run 'telo migrate' to apply it, or tag the value !literal if the text is meant literally.",
            source(dir.path(), "lib/telo.yaml")
        )
    );
}

/// The text a `!literal` resolves to is the author's, never an untagged interpolation.
#[test]
fn a_literal_holding_an_interpolation_is_no_untagged_one() {
    let (_dir, err) = load(&[
        ("app/telo.yaml", &string_field_app("!literal \"costs ${{ 5\"")),
        ("lib/telo.yaml", THING_LIBRARY),
    ]);
    assert_ne!(err.code, "ERR_UNTAGGED_INTERPOLATION", "{err}");
}
