use napi::{Env, JsObject, Result};
use napi_derive::napi;

#[napi]
pub fn create(_resource: JsObject, _ctx: JsObject) -> EchoInstance {
    EchoInstance {}
}

/// The same controller under a nested export, so a PURL `#echo` fragment has an
/// exports-object property to select.
#[napi(namespace = "echo", js_name = "create")]
pub fn echo_create(_resource: JsObject, _ctx: JsObject) -> EchoInstance {
    EchoInstance {}
}

#[napi]
// codeql[rust/access-invalid-pointer] napi-derive's generated unwrap starts from null_mut() and napi_unwrap fills it through an out-parameter, which this query cannot see
pub struct EchoInstance {}

#[napi]
impl EchoInstance {
    #[napi]
    pub fn invoke(&self, _env: Env, input: JsObject) -> Result<JsObject> {
        Ok(input)
    }
}
