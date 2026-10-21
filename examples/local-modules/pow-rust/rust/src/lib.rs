//! Controller for `PowRust.Mine`; the `entry` is the `#fragment` its PURL selects.

use std::fmt::Write;
use std::time::Instant;

use serde_json::json;
use sha2::{Digest, Sha256};
use telorun_sdk::{
    controller, Controller, ControllerError, InvokeContext, ResourceContext, Result, Value,
};

pub struct Mine;

#[controller(entry = "mine")]
impl Controller for Mine {
    fn create(_manifest: Value, _ctx: &dyn ResourceContext) -> Result<Self> {
        Ok(Self)
    }

    fn invoke(&self, input: Value, _ctx: &InvokeContext) -> Result<Value> {
        let text = input
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| ControllerError::new("ERR_INPUT_INVALID", "`text` must be a string"))?;
        let bits = input
            .get("difficulty")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ControllerError::new("ERR_INPUT_INVALID", "`difficulty` must be an integer")
            })?;

        let started = Instant::now();
        let mut message = String::from(text);
        for nonce in 0u64.. {
            message.truncate(text.len());
            write!(message, "{nonce}").expect("writing to a String cannot fail");
            let digest = Sha256::digest(message.as_bytes());
            if u64::from(leading_zero_bits(&digest)) >= bits {
                return Ok(json!({
                    "nonce": nonce,
                    "hash": hex(&digest),
                    "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
                }));
            }
        }
        unreachable!("the nonce space outlasts any difficulty the contract admits")
    }
}

fn leading_zero_bits(digest: &[u8]) -> u32 {
    let mut bits = 0;
    for byte in digest {
        if *byte != 0 {
            return bits + byte.leading_zeros();
        }
        bits += 8;
    }
    bits
}

fn hex(digest: &[u8]) -> String {
    digest.iter().fold(String::with_capacity(64), |mut out, byte| {
        write!(out, "{byte:02x}").expect("writing to a String cannot fail");
        out
    })
}
