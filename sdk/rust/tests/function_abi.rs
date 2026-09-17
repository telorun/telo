//! The function half of the C ABI, end to end: the `rust-functions` fixture is
//! built against the native backend, opened, and each `telo_function__<entry>`
//! vtable is driven through `create`, `call`, `destroy` and `free` as a host
//! would drive it.

use std::ffi::c_void;
use std::path::PathBuf;
use std::process::Command;

use telorun_abi::{function_symbol, TeloBuf, TeloFunction, TeloFunctionHost, TELO_ABI_VERSION, TELO_ERR, TELO_OK};

fn build_fixture() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let crate_dir = root.join("tests/__fixtures__/rust-functions/rust");
    let target_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("function-abi-target");
    let output = Command::new(env!("CARGO"))
        .current_dir(&crate_dir)
        .env("CARGO_TARGET_DIR", &target_dir)
        .args(["build", "--features", "telorun-sdk/native", "--message-format", "json-render-diagnostics"])
        .output()
        .expect("cargo runs");
    assert!(output.status.success(), "building the fixture failed:\n{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|message| message["reason"] == "compiler-artifact" && message["target"]["name"] == "rust_functions")
        .flat_map(|message| message["filenames"].as_array().cloned().unwrap_or_default())
        .filter_map(|file| file.as_str().map(PathBuf::from))
        .find(|file| matches!(file.extension().and_then(|e| e.to_str()), Some("so" | "dylib" | "dll")))
        .expect("cargo reported the fixture cdylib")
}

struct Loaded {
    _library: libloading::Library,
    vtables: Vec<(String, &'static TeloFunction)>,
}

impl Loaded {
    fn open() -> Self {
        let library = unsafe { libloading::Library::new(build_fixture()) }.expect("the fixture opens");
        let mut vtables = Vec::new();
        for entry in ["is_before", "echo_bytes", "explode", "marked"] {
            let symbol = function_symbol(entry);
            let vtable = unsafe {
                let export: libloading::Symbol<extern "C" fn() -> *const TeloFunction> =
                    library.get(symbol.as_bytes()).unwrap_or_else(|e| panic!("{symbol} is exported: {e}"));
                &*export()
            };
            vtables.push((entry.to_string(), vtable));
        }
        Self { _library: library, vtables }
    }

    fn vtable(&self, entry: &str) -> &'static TeloFunction {
        self.vtables.iter().find(|(name, _)| name == entry).unwrap().1
    }
}

unsafe extern "C" fn record_log(ctx: *mut c_void, severity: i32, message: *const u8, message_len: usize) {
    let lines = &mut *(ctx as *mut Vec<String>);
    let text = std::str::from_utf8(std::slice::from_raw_parts(message, message_len)).unwrap();
    lines.push(format!("{severity} {text}"));
}

fn take(vtable: &TeloFunction, buf: TeloBuf) -> String {
    let text = String::from_utf8(unsafe { buf.as_slice() }.to_vec()).unwrap();
    unsafe { (vtable.free)(buf) };
    text
}

fn create(vtable: &TeloFunction, config: &str, host: &TeloFunctionHost) -> *mut c_void {
    let mut err = TeloBuf::empty();
    let handle = unsafe { (vtable.create)(config.as_ptr(), config.len(), host, &mut err) };
    assert!(!handle.is_null(), "create failed: {}", take(vtable, err));
    handle
}

fn call(vtable: &TeloFunction, handle: *mut c_void, frame: &str) -> (i32, String) {
    let mut out = TeloBuf::empty();
    let status = unsafe { (vtable.call)(handle, frame.as_ptr(), frame.len(), &mut out) };
    (status, take(vtable, out))
}

fn destroy(vtable: &TeloFunction, handle: *mut c_void) {
    let mut err = TeloBuf::empty();
    let status = unsafe { (vtable.destroy)(handle, &mut err) };
    assert_eq!(status, TELO_OK, "destroy failed");
}

#[test]
fn drives_every_function_slot_over_typed_frames() {
    let loaded = Loaded::open();
    let mut lines: Vec<String> = Vec::new();
    let host = TeloFunctionHost { ctx: &mut lines as *mut Vec<String> as *mut c_void, log: record_log };

    let is_before = loaded.vtable("is_before");
    assert_eq!(is_before.abi_version, TELO_ABI_VERSION);
    let handle = create(is_before, "{}", &host);
    assert_eq!(lines, vec!["9 is_before created".to_string()]);
    let instants = |a: &str, b: &str| {
        format!(
            r#"{{"a":{{"$telo":"google.protobuf.Timestamp","value":"{a}"}},"b":{{"$telo":"google.protobuf.Timestamp","value":"{b}"}}}}"#
        )
    };
    assert_eq!(call(is_before, handle, &instants("2026-01-15T07:30:00.000Z", "2026-01-15T08:00:00.000Z")), (TELO_OK, "true".into()));
    assert_eq!(call(is_before, handle, &instants("2026-01-15T08:00:00.000Z", "2026-01-15T07:30:00.000Z")), (TELO_OK, "false".into()));
    destroy(is_before, handle);

    let echo = loaded.vtable("echo_bytes");
    let handle = create(echo, "{}", &host);
    let bytes = r#"{"$telo":"bytes","value":"AQL_"}"#;
    assert_eq!(call(echo, handle, &format!(r#"{{"data":{bytes}}}"#)), (TELO_OK, bytes.to_string()));
    destroy(echo, handle);

    let explode = loaded.vtable("explode");
    let handle = create(explode, "{}", &host);
    let (status, error) = call(explode, handle, "{}");
    assert_eq!(status, TELO_ERR);
    let error: serde_json::Value = serde_json::from_str(&error).unwrap();
    assert_eq!(error["code"], "ERR_CONTROLLER_PANIC");
    destroy(explode, handle);

    let marked = loaded.vtable("marked");
    let marker = tempfile_path("marked");
    let handle = create(marked, &format!(r#"{{"marker":{}}}"#, serde_json::json!(marker)), &host);
    assert!(!std::path::Path::new(&marker).exists());
    destroy(marked, handle);
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "dropped");
}

fn tempfile_path(name: &str) -> String {
    let path = std::env::temp_dir().join(format!("telorun-sdk-function-abi-{}-{name}", std::process::id()));
    if path.exists() {
        std::fs::remove_file(&path).expect("a stale marker is removable");
    }
    path.to_string_lossy().into_owned()
}
