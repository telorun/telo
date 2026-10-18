//! The engine's runtime library — `runtime-library.ts`, its first item.
//!
//! What it holds now is the bound a registration is checked against: the function
//! registry refuses a signature wider than an implementation receives, so the constant
//! is checked behaviour before anything here evaluates.
//!
//! Node items with no twin in this file yet, all arriving with evaluation: every
//! implementation of the standard library, `CelImplementation`, `CelCallContext`,
//! `implementationOf`, `implementedKeys`, `standardConstantValues`, `celTypeValueOf`,
//! `typeValueName`, `jsonAsCelValue`, `base64Text`, `optionalOfNonZero`.

/// How many values an implementation receives — its arguments, and the receiver of a
/// call written on a value. A signature declaring more is refused where it is registered.
pub const CALL_SITE_DIRECT_ARITY: usize = 4;
