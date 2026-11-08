//! The value a parameterized template evaluates to — the data half of `compiled-value.ts`.
//!
//! A `!sql` value is literal text fragments plus the separately evaluated value of each
//! hole, with one fragment more than values. A consumer emits its own placeholder between
//! fragments and binds the values, never splicing them into the text. It crosses the
//! controller boundary as the record `{ __teloParameterized: true, fragments, values }`,
//! keys in that order.
//!
//! Node items with no twin: `CompiledValue`, `CompiledCall` and `isCompiledValue` — in Rust
//! a compiled value holds an engine program, so it is `telo-templating`'s, and the SDK
//! never depends on the engine.

use telorun_cel_value::{CelRecord, CelValue};

/// The key marking a record as a parameterized template's value.
pub const PARAMETERIZED_KEY: &str = "__teloParameterized";

/// Literal text fragments and the value of each hole between them.
#[derive(Clone, PartialEq, Debug)]
pub struct ParameterizedSql {
    pub fragments: Vec<String>,
    pub values: Vec<CelValue>,
}

impl ParameterizedSql {
    /// The record a consumer receives.
    pub fn to_value(&self) -> CelValue {
        let mut record = CelRecord::new();
        record.insert(PARAMETERIZED_KEY, CelValue::Bool(true));
        record.insert(
            "fragments",
            CelValue::List(self.fragments.iter().map(|text| CelValue::String(text.as_str().into())).collect()),
        );
        record.insert("values", CelValue::List(self.values.iter().cloned().collect()));
        CelValue::Record(record)
    }

    /// The parameterized value a record holds, or `None` when it is not one: not marked,
    /// or marked with fragments that are not strings, values that are not a list, or one
    /// fragment more than values missing.
    pub fn from_value(value: &CelValue) -> Option<Self> {
        let CelValue::Record(record) = value else { return None };
        if record.get(PARAMETERIZED_KEY) != Some(&CelValue::Bool(true)) {
            return None;
        }
        let (Some(CelValue::List(fragments)), Some(CelValue::List(values))) = (record.get("fragments"), record.get("values"))
        else {
            return None;
        };
        let fragments = fragments
            .iter()
            .map(|fragment| match fragment {
                CelValue::String(text) => Some(text.to_string()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        (fragments.len() == values.len() + 1).then(|| Self { fragments, values: values.to_vec() })
    }
}

/// Whether a value is marked as a parameterized template's value — Node's
/// `isParameterizedSql`, which reads the mark alone.
pub fn is_parameterized_sql(value: &CelValue) -> bool {
    matches!(value, CelValue::Record(record) if record.get(PARAMETERIZED_KEY) == Some(&CelValue::Bool(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crosses_as_the_marked_record_and_reads_back_from_it() {
        let sql = ParameterizedSql {
            fragments: vec!["WHERE id = ".into(), "".into()],
            values: vec![CelValue::Int(7)],
        };
        let value = sql.to_value();
        let CelValue::Record(record) = &value else { panic!() };
        assert_eq!(record.keys().collect::<Vec<_>>(), [PARAMETERIZED_KEY, "fragments", "values"]);
        assert!(is_parameterized_sql(&value));
        assert_eq!(ParameterizedSql::from_value(&value), Some(sql));
    }

    #[test]
    fn reads_nothing_from_a_value_that_is_not_one() {
        assert!(!is_parameterized_sql(&CelValue::String("SELECT 1".into())));
        let unmarked: CelValue = CelValue::Record([("fragments", CelValue::List(Default::default()))].into_iter().collect());
        assert!(!is_parameterized_sql(&unmarked));
        assert_eq!(ParameterizedSql::from_value(&unmarked), None);
        let short = ParameterizedSql { fragments: vec![], values: vec![] }.to_value();
        assert!(is_parameterized_sql(&short));
        assert_eq!(ParameterizedSql::from_value(&short), None);
    }
}
