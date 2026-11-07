//! The CEL half of the tag layer, mirroring `../../../nodejs/src/cel/`: the two
//! environments and the value types they register, the verdict codes, compiling an
//! expression, module calls, written arguments, the call audit, what an expression reads,
//! and the hole grammar. The engine the tag engines run on is `telorun-cel`.

pub mod analyze;
pub mod compile;
pub mod diagnose;
pub mod environment;
pub mod interpolation_holes;
pub mod literal_argument;
pub mod module_call;
pub mod value_types;
pub mod verdict_codes;
