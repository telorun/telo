// The OCI ref grammar is pure string parsing shared with the browser-safe
// manifest-cache key helper, so it lives in `@telorun/analyzer`; this shim
// keeps the kernel-internal import sites stable.
export { OCI_SCHEME, isOciRef, parseOciRef, type ParsedOciRef } from "@telorun/analyzer";
