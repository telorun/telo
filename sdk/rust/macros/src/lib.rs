//! `#[controller]` proc macro for the Telo SDK.
//!
//! Applied to an `impl Controller for X` block, it preserves the trait impl and
//! emits an FFI-bound bridge for each active backend: an N-API class for the
//! Node.js kernel and a C-ABI vtable export for the Rust kernel.
//!
//! The optional `entry` argument names the exported controller, which is what a
//! `pkg:cargo` PURL selects with its `#fragment`:
//!
//! ```ignore
//! #[controller(entry = "writeline_controller")]
//! impl Controller for WriteLine { … }
//! ```
//!
//! Omitting it defaults the entry to the snake_case of the type and *also*
//! exports the crate's `default` entry — the one a fragment-less PURL resolves
//! to. Two entry-less controllers in one crate therefore collide at link time,
//! which is the correct failure: "the crate's single controller" can only be
//! claimed once.

use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::{parse_macro_input, Expr, ImplItem, ItemImpl, Lit, Meta, Type};

#[proc_macro_attribute]
pub fn controller(attr: TokenStream, item: TokenStream) -> TokenStream {
    let explicit_entry = match parse_entry(attr, "controller") {
        Ok(entry) => entry,
        Err(err) => return err.to_compile_error().into(),
    };
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
    let native_module = format_ident!("__telorun_{}_native", type_ident);
    let bridge_struct = format_ident!("{}Bridge", type_ident);
    let has_invoke = method_present(&input, "invoke");
    let has_snapshot = method_present(&input, "snapshot");

    let entry = explicit_entry
        .clone()
        .unwrap_or_else(|| to_snake_case(&type_ident.to_string()));
    let entry_fn = format_ident!("telo_controller__{}", entry);
    // Only an entry-less declaration claims the crate's `default` slot; an
    // explicit entry is one of several controllers and claims nothing.
    let default_entry_fn = explicit_entry
        .is_none()
        .then(|| format_ident!("telo_controller__default"));

    // napi-derive's generated code uses *relative* `napi::...` paths (verified
    // against napi-derive 2.x). We exploit that by aliasing the SDK's re-export
    // as a local `napi` module inside the bridge — both our hand-written types
    // and napi-derive's generated paths resolve through `::telorun_sdk::__napi`,
    // so the downstream controller crate does NOT need a direct napi/napi-derive
    // dependency. Only `telorun-sdk` needs to live in its `[dependencies]`.
    //
    // Every bridged return type is spelled `Result<…>` — the last path segment
    // literally `Result`. napi-derive decides whether a function returns a
    // Result by that segment's NAME, and only then generates the `Err` → throw
    // path; under any alias it converts the whole `Result` as a value, so an
    // `Err` reaches JavaScript as a RETURNED `Error` and the call "succeeds".
    //
    // Only the controller's own `Err` goes through `controller_error`, which
    // marks it as the controller's; a conversion failure is napi's own error,
    // thrown unmarked, so the Node kernel reports it as a plain failure.
    let invoke_fn = has_invoke.then(|| {
        quote! {
            #[napi]
            pub fn invoke(&self, env: Env, input: JsUnknown, ctx: Option<JsObject>) -> Result<JsUnknown> {
                let value = ::telorun_sdk::backend::napi::js_to_value(&env, input)?;
                // Poll-only cancellation: the token reads `ctx.cancellation.isCancelled`
                // from the JS InvokeContext on each `is_cancelled()` call.
                let invoke_ctx = ::telorun_sdk::backend::napi::invoke_context_from_js(ctx);
                let result = <super::#self_ty as ::telorun_sdk::Controller>::invoke(&self.inner, value, &invoke_ctx)
                    .map_err(|err| ::telorun_sdk::backend::napi::controller_error(&env, err))?;
                ::telorun_sdk::backend::napi::value_to_js(&env, &result)
            }
        }
    });

    let snapshot_fn = has_snapshot.then(|| {
        quote! {
            #[napi]
            pub fn snapshot(&self, env: Env) -> Result<JsUnknown> {
                let value = <super::#self_ty as ::telorun_sdk::Controller>::snapshot(&self.inner);
                ::telorun_sdk::backend::napi::value_to_js(&env, &value)
            }
        }
    });

    // Absent methods become `None` in the vtable rather than a stub that always
    // errors, so the kernel can say "this kind is not invocable" from the
    // vtable alone instead of discovering it mid-dispatch.
    let native_invoke = if has_invoke {
        quote! { ::core::option::Option::Some(::telorun_sdk::backend::native::invoke::<super::#self_ty>) }
    } else {
        quote! { ::core::option::Option::None }
    };
    let native_snapshot = if has_snapshot {
        quote! { ::core::option::Option::Some(::telorun_sdk::backend::native::snapshot::<super::#self_ty>) }
    } else {
        quote! { ::core::option::Option::None }
    };
    let default_entry_export = default_entry_fn.map(|name| {
        quote! {
            #[no_mangle]
            pub extern "C" fn #name() -> *const ::telorun_sdk::__abi::TeloController {
                &VTABLE
            }
        }
    });

    // The PURL's `#fragment` must select the same controller on both backends.
    // On the native side it names an exported symbol; on the napi side it has to
    // name a nested export, because the Node loader projects `module[entry]`.
    // An explicit entry therefore emits a napi *namespace* (`module.<entry>.create`)
    // rather than the flat `module.create` — which is also what lets one crate
    // carry two controllers without their `create`/`register` exports colliding.
    // Entry-less controllers keep the flat shape, matching the fragment-less PURL
    // that resolves to them.
    let napi_attr = match &explicit_entry {
        Some(entry) => quote! { #[napi(namespace = #entry)] },
        None => quote! { #[napi] },
    };

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
        #[allow(non_snake_case)]
        mod #bridge_module {
            // Alias the SDK's napi re-exports under their canonical names.
            // napi-derive's generated code uses relative `napi::...` paths
            // (verified in napi-derive 2.x source); they resolve to the alias
            // here, so the downstream crate does not need napi-rs deps directly.
            // The `napi` proc-macro attribute lives in a separate namespace
            // from items, so importing both as `napi` is unambiguous.
            use ::telorun_sdk::__napi as napi;
            use ::telorun_sdk::__napi_derive::napi;
            use ::telorun_sdk::__napi::{Env, JsObject, JsUnknown, Result};

            #napi_attr
            pub struct #bridge_struct {
                pub(super) inner: super::#self_ty,
            }

            #napi_attr
            impl #bridge_struct {
                #invoke_fn
                #snapshot_fn
            }

            #napi_attr
            pub fn register(env: Env, _ctx: JsObject) -> Result<()> {
                let ctx = ::telorun_sdk::backend::napi::NapiControllerContext;
                <super::#self_ty as ::telorun_sdk::Controller>::register(&ctx)
                    .map_err(|err| ::telorun_sdk::backend::napi::controller_error(&env, err))
            }

            #napi_attr
            pub fn create(env: Env, resource: JsUnknown, ctx: JsObject) -> Result<#bridge_struct> {
                let manifest = ::telorun_sdk::backend::napi::js_to_value(&env, resource)?;
                let ctx_impl = ::telorun_sdk::backend::napi::NapiResourceContext::new(env, ctx)?;
                let inner = <super::#self_ty as ::telorun_sdk::Controller>::create(manifest, &ctx_impl)
                    .map_err(|err| ::telorun_sdk::backend::napi::controller_error(&env, err))?;
                Ok(#bridge_struct { inner })
            }
        }
        }

        // Native backend bridge — one exported C symbol per controller entry,
        // returning a vtable whose slots are the SDK's generic shims. The
        // vtable is a `static` in the controller crate rather than a leaked
        // allocation, so repeated entry calls hand back the same pointer.
        ::telorun_sdk::__native_bridge! {
        #[doc(hidden)]
        #[allow(non_snake_case)]
        mod #native_module {
            static VTABLE: ::telorun_sdk::__abi::TeloController =
                ::telorun_sdk::backend::native::vtable::<super::#self_ty>(
                    #native_invoke,
                    #native_snapshot,
                );

            #[no_mangle]
            pub extern "C" fn #entry_fn() -> *const ::telorun_sdk::__abi::TeloController {
                &VTABLE
            }

            #default_entry_export
        }
        }
    };

    output.into()
}

/// `#[function]` — applied to an `impl Function for X` block, it preserves the
/// impl and exports the function under its entry on each active backend: a napi
/// namespace `<entry>` carrying `createFunction` for the Node.js kernel, and a
/// `telo_function__<entry>` symbol returning the C-ABI function vtable.
///
/// The entry is the PURL's `#fragment`. It defaults to the snake_case of the
/// type; a function is always exported under a namespace, since a crate
/// routinely carries several and a callable kind always names one.
///
/// Across napi the configuration crosses as plain JSON text and arguments and
/// results as typed frames, the same text the C ABI carries, so a CEL value
/// keeps its type identically on both backends.
#[proc_macro_attribute]
pub fn function(attr: TokenStream, item: TokenStream) -> TokenStream {
    let explicit_entry = match parse_entry(attr, "function") {
        Ok(entry) => entry,
        Err(err) => return err.to_compile_error().into(),
    };
    let input = parse_macro_input!(item as ItemImpl);
    let self_ty = &input.self_ty;
    let type_ident = match extract_type_ident(self_ty) {
        Some(id) => id,
        None => {
            return syn::Error::new_spanned(
                self_ty,
                "#[function] requires a simple type path (e.g. `impl Function for MyType`)",
            )
            .to_compile_error()
            .into();
        }
    };
    let entry = explicit_entry.unwrap_or_else(|| to_snake_case(&type_ident.to_string()));
    let bridge_module = format_ident!("__telorun_{}_function_bridge", type_ident);
    let native_module = format_ident!("__telorun_{}_function_native", type_ident);
    let bridge_struct = format_ident!("{}FunctionBridge", type_ident);
    let symbol = format_ident!("telo_function__{}", entry);

    let output = quote! {
        #input

        ::telorun_sdk::__bridge! {
        #[doc(hidden)]
        #[allow(non_snake_case)]
        mod #bridge_module {
            use ::telorun_sdk::__napi as napi;
            use ::telorun_sdk::__napi_derive::napi;
            use ::telorun_sdk::__napi::{Env, JsObject, Result};

            #[napi(namespace = #entry)]
            pub struct #bridge_struct {
                inner: ::core::option::Option<super::#self_ty>,
            }

            #[napi(namespace = #entry)]
            impl #bridge_struct {
                /// The typed frame of the result for the typed frame of the arguments.
                #[napi]
                pub fn call_frame(&self, env: Env, args: String) -> Result<String> {
                    ::telorun_sdk::backend::napi::call_function::<super::#self_ty>(self.inner.as_ref(), &args)
                        .map_err(|err| ::telorun_sdk::backend::napi::controller_error(&env, err))
                }

                /// Drop the instance — the inverse of `createFunction`.
                #[napi]
                pub fn destroy(&mut self, env: Env) -> Result<()> {
                    ::telorun_sdk::backend::napi::destroy_function::<super::#self_ty>(self.inner.take())
                        .map_err(|err| ::telorun_sdk::backend::napi::controller_error(&env, err))
                }
            }

            // A bridge the collector releases undestroyed still drops its
            // instance, and a panic there must not unwind into the finalizer.
            impl ::core::ops::Drop for #bridge_struct {
                fn drop(&mut self) {
                    ::telorun_sdk::backend::napi::finalize_function::<super::#self_ty>(self.inner.take());
                }
            }

            #[napi(namespace = #entry)]
            pub fn create_function(env: Env, config: String, ctx: JsObject) -> Result<#bridge_struct> {
                let inner = ::telorun_sdk::backend::napi::create_function::<super::#self_ty>(&env, &config, &ctx)
                    .map_err(|err| ::telorun_sdk::backend::napi::controller_error(&env, err))?;
                Ok(#bridge_struct { inner: ::core::option::Option::Some(inner) })
            }
        }
        }

        ::telorun_sdk::__native_bridge! {
        #[doc(hidden)]
        #[allow(non_snake_case)]
        mod #native_module {
            static VTABLE: ::telorun_sdk::__abi::TeloFunction =
                ::telorun_sdk::backend::native::function_vtable::<super::#self_ty>();

            #[no_mangle]
            pub extern "C" fn #symbol() -> *const ::telorun_sdk::__abi::TeloFunction {
                &VTABLE
            }
        }
        }
    };
    output.into()
}

/// Parse the optional `entry = "..."` argument of the attribute `macro_name`
/// (`controller` or `function`), which every message names. An empty attribute
/// yields `None`; anything other than that single name/value pair is rejected
/// rather than ignored, so a typo doesn't silently fall back to the default
/// entry. The entry becomes part of an exported symbol, so it is refused here
/// unless it is ASCII letters, digits and underscores.
fn parse_entry(attr: TokenStream, macro_name: &str) -> syn::Result<Option<String>> {
    if attr.is_empty() {
        return Ok(None);
    }
    let meta: Meta = syn::parse(attr)?;
    let name_value = match meta {
        Meta::NameValue(nv) => nv,
        other => {
            return Err(syn::Error::new_spanned(
                other,
                format!("#[{macro_name}] takes at most one argument: entry = \"<name>\""),
            ))
        }
    };
    if !name_value.path.is_ident("entry") {
        return Err(syn::Error::new_spanned(
            &name_value.path,
            format!("unknown #[{macro_name}] argument; the only supported one is entry = \"<name>\""),
        ));
    }
    let not_a_string = || format!("#[{macro_name}] entry must be a string literal");
    let Expr::Lit(lit) = &name_value.value else {
        return Err(syn::Error::new_spanned(&name_value.value, not_a_string()));
    };
    let Lit::Str(value) = &lit.lit else {
        return Err(syn::Error::new_spanned(&lit.lit, not_a_string()));
    };
    let entry = value.value();
    if entry.is_empty() || !entry.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err(syn::Error::new_spanned(
            value,
            format!(
                "#[{macro_name}] entry \"{entry}\" must be one or more ASCII letters, digits or underscores: it names an exported symbol and the manifest's `#<entry>` fragment"
            ),
        ));
    }
    Ok(Some(entry))
}

/// `WriteLine` → `write_line`. Used for the default entry name so a
/// single-controller crate needs no attribute at all.
fn to_snake_case(ident: &str) -> String {
    let mut out = String::with_capacity(ident.len() + 4);
    for (index, ch) in ident.char_indices() {
        if ch.is_uppercase() {
            if index != 0 {
                out.push('_');
            }
            out.extend(ch.to_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
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
