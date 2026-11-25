//! A schema refusal in the value-issue vocabulary — what every `ERR_INPUT_INVALID` /
//! `ERR_OUTPUT_INVALID` a schema raised carries as `data.issues`, so a caller can say where a
//! value failed without parsing the message. Mirrors `../../nodejs/src/schema-value-issues.ts`.
//! A value is never quoted: the pointer, the keyword and its params say where and what.

use serde_json::{json, Value};
use telo_analyzer::schema_error_report::SchemaIssue;
use telorun_sdk_core::value_type::X_TELO_TYPE;

use crate::schema_validator::SchemaRefusal;

/// `valueIssue`: one finding in the vocabulary — `keyword` and the params its entry names.
pub fn value_issue(pointer: &str, keyword: &str, params: Value) -> Value {
    json!({ "pointer": pointer, "keyword": keyword, "params": params })
}

/// `schemaValueIssue`: a value type that does not read is `format`, a missing property
/// `required`, anything else `invalid` — the validator's sentence stays in the message.
pub fn schema_value_issue(issue: &SchemaIssue) -> Value {
    let pointer = issue.pointer.as_deref().unwrap_or("");
    if issue.keyword.as_deref() == Some(X_TELO_TYPE) {
        if let Some(value_type) = issue.value_type.as_deref() {
            return value_issue(pointer, "format", json!({ "format": value_type }));
        }
    }
    if issue.keyword.as_deref() == Some("required") {
        let params = match &issue.missing_property {
            Some(missing) => json!({ "missingProperty": missing }),
            None => json!({}),
        };
        return value_issue(pointer, "required", params);
    }
    value_issue(pointer, "invalid", json!({}))
}

/// `schemaRefusalData`: the `data` a refusal carries — its issues when the validation
/// finished and located them, else nothing.
pub fn schema_refusal_data(refusal: &SchemaRefusal) -> Option<Value> {
    let issues = refusal.issues.as_ref()?;
    Some(json!({ "issues": issues.iter().map(schema_value_issue).collect::<Vec<_>>() }))
}
