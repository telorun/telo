---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/ide-support": minor
---

`telo check` and the kernel now judge the same needs and the same observing slots. An `observes` slot an abstract declares is judged at each implementation in `telo check` as the kernel judges it at registration, so a templated or sink implementation inheriting one is `X_TELO_REF_INVALID_OBSERVES`, naming the ancestor that declares the slot, instead of passing the check and failing at boot; a malformed slot is still reported once, at the kind that declares it. A version that version reconciliation lost, and every module only it imports, is no longer judged by the need table, so a defect only they carry refuses neither `telo run` nor `telo needs report`. A sensitive need-type field whose mark is not `true`, or that holds no text, is a need-table refusal: reported in an importer's check at the import that reaches the library, and refused at load for every module as `ERR_SENSITIVE_ANNOTATION_INVALID`. A load the need table refuses carries every other error the analysis found in the same refusal, each once.

A diagnostic naming both a resource and its file is located in that file, so two modules declaring the same name no longer point a reader at the wrong one. The passes that skip what is not an instance recognise a kind document through the one kind-declaration reader, so a `Telo.Abstract` is no longer a call-graph node; `AnalysisRegistry.visitManifest` takes a `skip` document predicate in place of the `skipKinds` set.
