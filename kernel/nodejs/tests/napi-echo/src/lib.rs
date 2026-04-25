use napi::{Env, JsObject, Result};
use napi_derive::napi;

#[napi]
pub fn create(_resource: JsObject, _ctx: JsObject) -> EchoInstance {
    EchoInstance {}
}

#[napi]
pub struct EchoInstance {}

#[napi]
impl EchoInstance {
    #[napi]
    pub fn invoke(&self, _env: Env, input: JsObject) -> Result<JsObject> {
        Ok(input)
    }
}
