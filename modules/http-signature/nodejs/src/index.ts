// The HTTP signature grammar a transport calls with a plain request description.
export type { RequestDescription } from "./request-description.js";
export { headerValue } from "./request-description.js";
export type { SignaturePresentation, SignatureReading } from "./signature-reading.js";
export { readMessageSignature, type MessageSignatureOptions } from "./message-signature.js";
export { readBodySignature, decodeSignature, type BodySignatureOptions, type SignatureEncoding } from "./body-signature.js";
export { evaluateBaseParts, type BasePart } from "./base-parts.js";
export { verifyContentDigest, type DigestVerdict } from "./content-digest.js";
export { buildSignatureBase, requiredComponentId } from "./signature-base.js";
export { parseSignatureInput, parseSignatures, type SignatureInput } from "./signature-headers.js";
export { compilePattern } from "./patterns.js";
export { SignatureMalformed } from "./signature-failure.js";
export * from "./structured-fields.js";
