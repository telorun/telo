//! `#[controller]` proc macro for the Telo SDK.
//!
//! Applied to an `impl Controller for X` block, it preserves the trait
//! impl and emits an FFI-bound bridge for the active backend. Today only
//! the napi backend ships; the native backend has no bridge code (the
//! future Rust kernel uses the trait directly).

use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::{parse_macro_input, ImplItem, ItemImpl, Type};

#[proc_macro_attribute]
pub fn controller(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemImpl);
    let self_ty = &input.self_ty;
    let type_ident = match extract_type_ident(self_ty) {
        Some(id) => id,
        None => {
            return syn::Error::new_spanned(
                self_ty,
                "#[controller] requires a simple type path (e.g. `impl Controller for MyType`)",
            )
            .to_compile_error()
            .into();
        }
    };

    let bridge_module = format_ident!("__telorun_{}_bridge", type_ident);
    let bridge_struct = format_ident!("{}Bridge", type_ident);
    let has_invoke = method_present(&input, "invoke");
    let has_snapshot = method_present(&input, "snapshot");

    // napi-derive's generated code uses *relative* `napi::...` paths (verified
    // against napi-derive 2.x). We exploit that by aliasing the SDK's re-export
    // as a local `napi` module inside the bridge — both our hand-written types
    // and napi-derive's generated paths resolve through `::telorun_sdk::__napi`,
    // so the downstream controller crate does NOT need a direct napi/napi-derive
    // dependency. Only `telorun-sdk` needs to live in its `[dependencies]`.
    let invoke_fn = has_invoke.then(|| {
        quote! {
            #[napi]
            pub fn invoke(&self, env: Env, input: JsUnknown) -> NapiResult<JsUnknown> {
                let value = ::telorun_sdk::backend::napi::js_to_value(&env, input)
                    .map_err(::telorun_sdk::backend::napi::to_napi_error)?;
                let result = <super::#self_ty as ::telorun_sdk::Controller>::invoke(&self.inner, value)
                    .map_err(::telorun_sdk::backend::napi::to_napi_error)?;
                ::telorun_sdk::backend::napi::value_to_js(&env, &result)
                    .map_err(::telorun_sdk::backend::napi::to_napi_error)
            }
        }
    });

    let snapshot_fn = has_snapshot.then(|| {
        quote! {
            #[napi]
            pub fn snapshot(&self, env: Env) -> NapiResult<JsUnknown> {
                let value = <super::#self_ty as ::telorun_sdk::Controller>::snapshot(&self.inner);
                ::telorun_sdk::backend::napi::value_to_js(&env, &value)
                    .map_err(::telorun_sdk::backend::napi::to_napi_error)
            }
        }
    });

    let output = quote! {
        // Trait impl preserved verbatim so the controller is usable directly
        // (e.g. by a future Rust kernel) and so `cargo check --features native`
        // exercises the same code path the napi backend exercises.
        #input

        // Napi backend bridge — wrapped in `::telorun_sdk::__bridge!` so the
        // SDK's own feature selection drives whether this code compiles. With
        // the SDK's `napi` feature on (today's only shipping backend), the
        // macro expands to its body; with `native`, it expands to nothing and
        // no `__napi` references reach the build graph.
        ::telorun_sdk::__bridge! {
        #[doc(hidden)]
        mod #bridge_module {
            // Alias the SDK's napi re-exports under their canonical names.
            // napi-derive's generated code uses relative `napi::...` paths
            // (verified in napi-derive 2.x source); they resolve to the alias
            // here, so the downstream crate does not need napi-rs deps directly.
            // The `napi` proc-macro attribute lives in a separate namespace
            // from items, so importing both as `napi` is unambiguous.
            use ::telorun_sdk::__napi as napi;
            use ::telorun_sdk::__napi_derive::napi;
            use ::telorun_sdk::__napi::{Env, JsObject, JsUnknown, Result as NapiResult};

            #[napi]
            pub struct #bridge_struct {
                pub(super) inner: super::#self_ty,
            }

            #[napi]
            impl #bridge_struct {
                #invoke_fn
                #snapshot_fn
            }

            #[napi]
            pub fn register(_env: Env, _ctx: JsObject) -> NapiResult<()> {
                let ctx = ::telorun_sdk::backend::napi::NapiControllerContext;
                <super::#self_ty as ::telorun_sdk::Controller>::register(&ctx)
                    .map_err(::telorun_sdk::backend::napi::to_napi_error)
            }

            #[napi]
            pub fn create(env: Env, resource: JsUnknown, ctx: JsObject) -> NapiResult<#bridge_struct> {
                let manifest = ::telorun_sdk::backend::napi::js_to_value(&env, resource)
                    .map_err(::telorun_sdk::backend::napi::to_napi_error)?;
                let ctx_impl = ::telorun_sdk::backend::napi::NapiResourceContext::new(env, ctx)
                    .map_err(::telorun_sdk::backend::napi::to_napi_error)?;
                let inner = <super::#self_ty as ::telorun_sdk::Controller>::create(manifest, &ctx_impl)
                    .map_err(::telorun_sdk::backend::napi::to_napi_error)?;
                Ok(#bridge_struct { inner })
            }
        }
        }
    };

    output.into()
}

fn extract_type_ident(ty: &Type) -> Option<syn::Ident> {
    if let Type::Path(p) = ty {
        if let Some(seg) = p.path.segments.last() {
            return Some(seg.ident.clone());
        }
    }
    None
}

fn method_present(impl_block: &ItemImpl, name: &str) -> bool {
    impl_block.items.iter().any(|item| {
        if let ImplItem::Fn(func) = item {
            func.sig.ident == name
        } else {
            false
        }
    })
}
