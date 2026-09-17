/**
 * **Whether one callable signature can stand in for another** — the one
 * comparison behind both places a function is held against a signature it does
 * not declare: a callable kind replacing an abstract ancestor's signature
 * (`CONTRACT_NOT_SUBSTITUTABLE`), and a function wired into a slot constrained to
 * a callable abstract it does not extend (`REFERENCE_KIND_MISMATCH`).
 *
 *  - `returns` is COVARIANT — a caller holding the function through the required
 *    signature reads the shape that signature declares.
 *  - `params` is CONTRAVARIANT, positional and NAMED: a CEL call site passes
 *    arguments by position, while a controller holding the function through a
 *    slot calls `call({ <name>: … })` with the names the slot's abstract
 *    declares. Arity is judged the same way, and only definitely: requiring more
 *    arguments than the required signature requires, or accepting fewer, fails a
 *    call written against it.
 *
 * Only DEFINITE mismatches are reported — `checkSchemaCompatibility`'s rule — so
 * narrowing a result or adding an optional parameter stays legal.
 *
 * Browser-safe: no Node built-ins.
 */
import {
  readParams,
  readReturns,
  signatureSchemaOf,
  type SignatureParam,
} from "./callable-signature.js";
import { checkSchemaCompatibility } from "./schema-compat.js";

export type SignatureMismatch =
  | { readonly kind: "returns"; readonly issues: readonly string[] }
  | { readonly kind: "requires-more"; readonly required: number; readonly requires: number }
  | { readonly kind: "accepts-fewer"; readonly accepts: number; readonly required: number }
  | {
      readonly kind: "parameter";
      readonly index: number;
      readonly name: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: "parameter-name";
      readonly index: number;
      readonly name: string;
      readonly expected: string;
    };

/** The halves of a signature each side declares — a document holding `params`
 *  and / or `returns`. */
export type SignatureDocument = Record<string, unknown> | undefined;

export function signatureMismatches(
  own: SignatureDocument,
  required: SignatureDocument,
  halves: { readonly params: boolean; readonly returns: boolean },
  resolveRef: (ref: string) => Record<string, any> | undefined,
): SignatureMismatch[] {
  const out: SignatureMismatch[] = [];

  if (halves.returns) {
    const ownSchema = signatureSchemaOf(readReturns(own));
    const requiredSchema = signatureSchemaOf(readReturns(required));
    if (ownSchema && requiredSchema) {
      const { compatible, issues } = checkSchemaCompatibility(ownSchema, requiredSchema, resolveRef);
      if (!compatible) out.push({ kind: "returns", issues });
    }
  }

  if (halves.params) {
    const ownParams = readParams(own) ?? [];
    const requiredParams = readParams(required) ?? [];
    const requiredCount = (params: readonly SignatureParam[]): number =>
      params.filter((p) => p.optional !== true).length;
    const ownRequired = requiredCount(ownParams);
    const requiredRequired = requiredCount(requiredParams);
    if (ownRequired > requiredRequired) {
      out.push({ kind: "requires-more", required: ownRequired, requires: requiredRequired });
    } else if (ownParams.length < requiredRequired) {
      out.push({ kind: "accepts-fewer", accepts: ownParams.length, required: requiredRequired });
    } else {
      ownParams.forEach((param, index) => {
        const counterpart = requiredParams[index];
        if (!counterpart) return;
        const name = typeof param.name === "string" ? param.name : `#${index}`;
        if (typeof counterpart.name === "string" && counterpart.name !== param.name) {
          out.push({ kind: "parameter-name", index, name, expected: counterpart.name });
          return;
        }
        const ownSchema = signatureSchemaOf(param);
        const requiredSchema = signatureSchemaOf(counterpart);
        if (!ownSchema || !requiredSchema) return;
        // Contravariant: the REQUIRED signature's argument must be acceptable
        // where this parameter is declared, so the arguments are swapped.
        const { compatible, issues } = checkSchemaCompatibility(
          requiredSchema,
          ownSchema,
          resolveRef,
        );
        if (compatible) return;
        out.push({ kind: "parameter", index, name, issues });
      });
    }
  }

  return out;
}
