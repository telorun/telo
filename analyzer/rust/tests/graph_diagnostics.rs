//! The analysis of a manifest tree, assembled as `telo check` assembles it, held to what
//! the Node analyzer reports for the same tree: every diagnostic whole, `data` included, and
//! the range each is shown at. Each expectation was recorded by running the Node analyzer
//! over these files; `filePath` and the located file are relative to the entry's directory.

use std::collections::HashMap;

use serde_json::{json, Value};
use telo_analyzer::{
    analyze, assemble_graph_diagnostics, load_graph, locate_diagnostic, AnalysisOptions, LoadError, ManifestLoader,
    ManifestSource, ReadManifest,
};

/// Files by absolute path; a directory reads its `telo.yaml`.
struct MemorySource(HashMap<String, String>);

impl ManifestSource for MemorySource {
    fn supports(&self, _: &str) -> bool {
        true
    }

    fn read(&self, path: &str) -> Result<ReadManifest, LoadError> {
        let source = if self.0.contains_key(path) { path.to_string() } else { format!("{path}/telo.yaml") };
        let text = self.0.get(&source).cloned().ok_or_else(|| LoadError::Io {
            path: path.to_string(),
            message: "not found".to_string(),
        })?;
        Ok(ReadManifest { text, source })
    }
}

fn relative(value: &mut Value, dir: &str) {
    match value {
        Value::String(text) => {
            if let Some(rest) = text.strip_prefix(dir) {
                *text = rest.to_string();
            }
        }
        Value::Object(map) => map.values_mut().for_each(|v| relative(v, dir)),
        Value::Array(items) => items.iter_mut().for_each(|v| relative(v, dir)),
        _ => {}
    }
}

fn check(files: &[(&str, &str)], entry: &str) -> Value {
    let loader = ManifestLoader::new(vec![Box::new(MemorySource(
        files.iter().map(|(path, text)| (path.to_string(), text.to_string())).collect(),
    ))]);
    let graph = load_graph(&loader, entry).expect("graph loads");
    let analysis = analyze(&graph, &AnalysisOptions { accepts_value: &|_, _, _| false });
    let dir = format!("{}/", entry.rsplit_once('/').unwrap().0);
    let rows = assemble_graph_diagnostics(&graph, analysis)
        .diagnostics
        .iter()
        .map(|d| {
            let located = locate_diagnostic(&graph, d).expect("located");
            let mut row = serde_json::to_value(d).unwrap();
            row["located"] = json!({ "file": located.file, "range": located.range });
            relative(&mut row, &dir);
            row
        })
        .collect();
    Value::Array(rows)
}

#[test]
fn every_refusal_the_analysis_makes_in_node_s_order() {
    let files = [
        ("/ws/app/telo.yaml", "kind: Telo.Application\nmetadata: { name: Telo }\nimports:\n  Lib: ../lib\n  Two: ../two\ntargets:\n  - invoke: { kind: Self.Greeter, name: greeter }\n---\nkind: Telo.Definition\nmetadata: { name: Own }\ncapability: Telo.Invokable\n---\nkind: Telo.Definition\nmetadata: { name: Greeter }\ncapability: Telo.Invocable\n---\nkind: Telo.Definition\nmetadata: { name: Router }\ncapability: Telo.Invocable\nschema:\n  type: object\n  properties:\n    handler: { x-telo-ref: { kind: Telo.Invocable, use: call } }\n---\nkind: Self.Greeter\nmetadata: { name: greeter }\n---\nkind: Self.Router\nmetadata: { name: router }\nhandler: { kind: Self.Greeter, name: greeter }\n"),
        ("/ws/lib/telo.yaml", "kind: Telo.Library\nmetadata: { name: CapLib }\n---\nkind: Telo.Definition\nmetadata: { name: M }\ncapability: Telo.Template\n"),
        ("/ws/two/telo.yaml", "kind: Telo.Library\nmetadata: { name: CapTwo }\nimports: { Inner: ../lib }\n---\nkind: Telo.Abstract\nmetadata: { name: A }\ncapability: Nope\n"),
    ];
    let expected: Value = serde_json::from_str(r#"[
 {
  "severity": 1,
  "code": "CAPABILITY_UNKNOWN",
  "source": "telo-analyzer",
  "message": "Telo.Definition 'Own': 'Telo.Invokable' is not a capability. Did you mean 'Telo.Invocable'? A capability names a lifecycle role — one of: Telo.Callable, Telo.Invocable, Telo.Mount, Telo.Provider, Telo.Runnable, Telo.Service, Telo.Sink, Telo.Type.",
  "data": {
   "resource": {
    "kind": "Telo.Definition",
    "name": "Own"
   },
   "filePath": "telo.yaml",
   "path": "capability"
  },
  "located": {
   "file": "telo.yaml",
   "range": {
    "start": {
     "line": 10,
     "character": 12
    },
    "end": {
     "line": 10,
     "character": 26
    }
   }
  }
 },
 {
  "severity": 1,
  "code": "CAPABILITY_NOT_DECLARABLE",
  "source": "telo-analyzer",
  "message": "Imported library 'CapLib', reached through import 'Lib': Telo.Definition 'M': 'Telo.Template' cannot be declared as a capability: The lifecycle of a document that declares rather than runs: an application, a library, an import, a kind or a need type. Read by the kernel while it loads a module, never instantiated, and reserved for the built-in vocabulary — a kind declared in a module never takes this role. Declare one of: Telo.Callable, Telo.Invocable, Telo.Mount, Telo.Provider, Telo.Runnable, Telo.Service, Telo.Sink, Telo.Type.",
  "data": {
   "filePath": "telo.yaml",
   "path": "imports.Lib"
  },
  "located": {
   "file": "telo.yaml",
   "range": {
    "start": {
     "line": 3,
     "character": 7
    },
    "end": {
     "line": 3,
     "character": 13
    }
   }
  }
 },
 {
  "severity": 1,
  "code": "CAPABILITY_UNKNOWN",
  "source": "telo-analyzer",
  "message": "Imported library 'CapTwo', reached through import 'Two': Telo.Abstract 'A': 'Nope' is not a capability: a lifecycle role is written 'Telo.<Role>'. One of: Telo.Callable, Telo.Invocable, Telo.Mount, Telo.Provider, Telo.Runnable, Telo.Service, Telo.Sink, Telo.Type.",
  "data": {
   "filePath": "telo.yaml",
   "path": "imports.Two"
  },
  "located": {
   "file": "telo.yaml",
   "range": {
    "start": {
     "line": 4,
     "character": 7
    },
    "end": {
     "line": 4,
     "character": 13
    }
   }
  }
 },
 {
  "severity": 1,
  "code": "INVALID_REFERENCE_FORM",
  "source": "telo-analyzer",
  "message": "Telo.Application/Telo: object reference '{ kind, name }' at 'targets[0].invoke' is not supported; write it as '!ref greeter'",
  "data": {
   "resource": {
    "kind": "Telo.Application",
    "name": "Telo"
   },
   "filePath": "telo.yaml",
   "path": "targets[0].invoke",
   "quotedPlace": [
    {
     "before": "Telo.Application/Telo: object reference '{ kind, name }' at '",
     "after": "' is not supported; write it as '!ref greeter'",
     "place": "targets[0].invoke",
     "from": 0,
     "path": "targets[0].invoke",
     "form": "dotted"
    }
   ]
  },
  "located": {
   "file": "telo.yaml",
   "range": {
    "start": {
     "line": 6,
     "character": 12
    },
    "end": {
     "line": 6,
     "character": 49
    }
   }
  }
 },
 {
  "severity": 1,
  "code": "INVALID_REFERENCE_FORM",
  "source": "telo-analyzer",
  "message": "Self.Router/router: object reference '{ kind, name }' at 'handler' is not supported; write it as '!ref greeter'",
  "data": {
   "resource": {
    "kind": "Self.Router",
    "name": "router"
   },
   "filePath": "telo.yaml",
   "path": "handler",
   "quotedPlace": [
    {
     "before": "Self.Router/router: object reference '{ kind, name }' at '",
     "after": "' is not supported; write it as '!ref greeter'",
     "place": "handler",
     "from": 0,
     "path": "handler",
     "form": "dotted"
    }
   ]
  },
  "located": {
   "file": "telo.yaml",
   "range": {
    "start": {
     "line": 29,
     "character": 9
    },
    "end": {
     "line": 29,
     "character": 46
    }
   }
  }
 },
 {
  "severity": 1,
  "code": "KIND_PREFIX_RESERVED",
  "source": "telo-analyzer",
  "message": "Telo.Application/Telo: A module may not be named 'Telo': `Telo.<Kind>` names a built-in kind and `Self.<Kind>` the declaring module's own, so its kinds would replace them. Rename the module.",
  "data": {
   "resource": {
    "kind": "Telo.Application",
    "name": "Telo"
   },
   "filePath": "telo.yaml",
   "path": "metadata.name"
  },
  "located": {
   "file": "telo.yaml",
   "range": {
    "start": {
     "line": 1,
     "character": 18
    },
    "end": {
     "line": 1,
     "character": 22
    }
   }
  }
 }
]"#).unwrap();
    assert_eq!(check(&files, "/ws/app/telo.yaml"), expected);
}

/// A kind declaring `name` only through the kind it extends makes `{ kind, name }` an
/// inline declaration, so no reference form is refused.
#[test]
fn a_name_declared_through_extends_is_not_a_legacy_reference_form() {
    let files = [(
        "/ws/telo.yaml",
        "kind: Telo.Application\nmetadata: { name: ExtendsApp }\ntargets:\n  - { invoke: { kind: Self.Child, name: child } }\n---\nkind: Telo.Definition\nmetadata: { name: Base }\ncapability: Telo.Invocable\nschema:\n  type: object\n  properties:\n    name: { type: string }\n---\nkind: Telo.Definition\nmetadata: { name: Child }\nextends: Self.Base\n",
    )];
    assert_eq!(check(&files, "/ws/telo.yaml"), json!([]));
}
