/**
 * Types as text: `list<int>`, `map<string, int>`, `optional<T>`, `Money<string>`.
 *
 * A host declares a variable's or a signature's type as a string, and the signature
 * data a port reads is text, so one grammar reads both. It is deliberately the same
 * spelling `formatType` writes, so a type that round-trips through text is the type
 * it started as — which is what lets the definition listing and the signature data
 * be compared without a second parser.
 *
 * A bare capital letter is a type **parameter**, which is how a signature says "the
 * same type here and there". A name the host registered as a nominal type resolves
 * to it; any other name is refused rather than guessed — as a
 * {@link CelUnknownTypeNameError}, which a caller holding the name's source may turn
 * into a verdict — because a misspelled type in a signature would otherwise register a
 * function nothing can call.
 */

import type { CelType, PrimitiveName } from "./cel-type.js";
import {
  BOOL,
  BYTES,
  DOUBLE,
  DYN,
  DURATION,
  INT,
  listOf,
  mapOf,
  NULL,
  optionalOf,
  parameterOf,
  STRING,
  TIMESTAMP,
  TYPE,
  UINT,
  WELL_KNOWN_TYPE_NAMES,
} from "./cel-type.js";

export class CelTypeExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CelTypeExpressionError";
  }
}

/**
 * A well-formed type expression naming a type nothing is registered under.
 *
 * It is **not** a `CelTypeExpressionError`, and the split is the whole point: that error
 * is about text this grammar cannot read, while this one is about a name the HOST and its
 * own registry disagree about. A caller that holds where the name was written can turn it
 * into a ranged verdict instead of a crash — which is what a namespace declaration built
 * out of a host's data does — and a caller that cannot still lets it fly.
 */
export class CelUnknownTypeNameError extends Error {
  /** The name nothing is registered under. */
  readonly typeName: string;

  constructor(typeName: string) {
    super(`no type is registered under the name ${JSON.stringify(typeName)}`);
    this.name = "CelUnknownTypeNameError";
    this.typeName = typeName;
  }
}

const PRIMITIVES: Readonly<Record<string, CelType>> = {
  dyn: DYN,
  int: INT,
  uint: UINT,
  double: DOUBLE,
  bool: BOOL,
  string: STRING,
  bytes: BYTES,
  null: NULL,
  null_type: NULL,
  type: TYPE,
  timestamp: TIMESTAMP,
  duration: DURATION,
};

const PARAMETER = /^[A-Z]$/;

/** What a name that is neither a primitive nor a parameter resolves to. */
export type NominalResolver = (name: string, args: readonly CelType[]) => CelType | undefined;

/**
 * Reads one type expression. `resolveNominal` is consulted for every name the
 * language itself does not define.
 */
export function parseTypeExpression(text: string, resolveNominal?: NominalResolver): CelType {
  const reader = new TypeReader(text, resolveNominal);
  const type = reader.read();
  reader.expectEnd();
  return type;
}

class TypeReader {
  private at = 0;

  constructor(
    private readonly text: string,
    private readonly resolveNominal?: NominalResolver,
  ) {}

  read(): CelType {
    const name = this.readName();
    const args = this.readArguments();
    return this.resolve(name, args);
  }

  expectEnd(): void {
    this.skipSpace();
    if (this.at !== this.text.length) {
      throw new CelTypeExpressionError(`${JSON.stringify(this.text)} is not one type expression`);
    }
  }

  /** Reads the next type of a list, stopping at `,` or `>`. */
  readArgument(): CelType {
    return this.read();
  }

  private skipSpace(): void {
    while (this.text[this.at] === " ") this.at += 1;
  }

  private readName(): string {
    this.skipSpace();
    const from = this.at;
    while (this.at < this.text.length && /[A-Za-z0-9_.]/.test(this.text[this.at]!)) this.at += 1;
    if (this.at === from) {
      throw new CelTypeExpressionError(`${JSON.stringify(this.text)} names no type at offset ${from}`);
    }
    return this.text.slice(from, this.at);
  }

  private readArguments(): CelType[] {
    this.skipSpace();
    if (this.text[this.at] !== "<") return [];
    this.at += 1;
    const args: CelType[] = [this.readArgument()];
    for (;;) {
      this.skipSpace();
      const next = this.text[this.at];
      if (next === ",") {
        this.at += 1;
        args.push(this.readArgument());
        continue;
      }
      if (next === ">") {
        this.at += 1;
        return args;
      }
      throw new CelTypeExpressionError(
        `${JSON.stringify(this.text)} has no closing '>' for its type arguments`,
      );
    }
  }

  private resolve(name: string, args: readonly CelType[]): CelType {
    const wellKnown = WELL_KNOWN_TYPE_NAMES[name];
    if (wellKnown) return this.noArguments(name, args, PRIMITIVES[wellKnown as PrimitiveName]!);
    if (name === "list") return args.length === 1 ? listOf(args[0]!) : listOf(DYN);
    if (name === "map") return args.length === 2 ? mapOf(args[0]!, args[1]!) : mapOf(DYN, DYN);
    if (name === "optional") {
      if (args.length !== 1) {
        throw new CelTypeExpressionError("optional takes exactly one type argument");
      }
      return optionalOf(args[0]!);
    }
    const primitive = PRIMITIVES[name];
    if (primitive) return this.noArguments(name, args, primitive);
    if (PARAMETER.test(name)) return this.noArguments(name, args, parameterOf(name));
    const nominal = this.resolveNominal?.(name, args);
    if (nominal) return nominal;
    throw new CelUnknownTypeNameError(name);
  }

  private noArguments(name: string, args: readonly CelType[], type: CelType): CelType {
    if (args.length > 0) throw new CelTypeExpressionError(`${name} takes no type arguments`);
    return type;
  }
}
