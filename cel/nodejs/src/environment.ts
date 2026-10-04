/**
 * An environment: what names, functions and types an expression is read against.
 *
 * **Everything is registered the same way, including the standard library.** There is
 * no privileged door: a host can replace `duration(string)` with its own, or remove a
 * standard function so a call to it is refused, because the library came in through the
 * same `registerFunction` a host uses. An engine with a built-in library behind a
 * private registration is an engine whose library cannot be changed — which is the
 * concrete thing this package exists to fix.
 *
 * `clone()` inherits everything and then diverges: registering or removing on the clone
 * leaves the parent as it was. That is what lets one base environment be built once and
 * specialised per site.
 *
 * **Two seams, and only two, let a host's vocabulary in**: `registerType`, for a named
 * type over a base with its own operators and members, and `resolveSchemaType`, asked at
 * every node of a JSON Schema before the structural rules. Nothing in this package knows
 * any host's type names.
 */

import type { CelActivation } from "./activation.js";
import { BoundedCache } from "./bounded-cache.js";
import type { CelExpression } from "./cel-expression.js";
import { parseExpression, resolvedUnder } from "./cel-expression.js";
import type { CelProgram, EvaluateOptions } from "./cel-program.js";
import { compileExpression } from "./cel-program.js";
import type { CompileTarget } from "./backend-runtime.js";
import type {
  EmittedExpression,
  EmittedModule,
  EmittedModuleStore,
  EmittedRuntime,
  StoredEmittedModule,
} from "./emitted-module.js";
import { emitModule, emitterRuntime, storedEmittedModule } from "./emitted-module.js";
import { environmentDigest } from "./environment-digest.js";
import type { CelValue } from "./cel-value.js";
import { CEL_VALUE_KEYS } from "./cel-value.js";
import type { CelType } from "./cel-type.js";
import { DYN, formatType } from "./cel-type.js";
import { CelEngineError } from "./check-diagnostic.js";
import type { CheckResult, NamespaceFunction } from "./checker.js";
import { checkExpression } from "./checker.js";
import { FunctionRegistry } from "./function-registry.js";
import type {
  FieldDeclaration,
  JsonSchemaNode,
  RecursiveSchemaReference,
  SchemaTypeResolver,
  UnjudgedSchemaNode,
} from "./json-schema-type.js";
import { fieldMapType, schemaType } from "./json-schema-type.js";
import { normalizeNamespaces } from "./namespace-resolution.js";
import type { NominalTypeDefinition, RegisteredType } from "./nominal-type.js";
import {
  buildRegisteredType,
  CelTypeRegistrationError,
  nominalOperators,
  nominalSignatures,
} from "./nominal-type.js";
import type { CelParseLimits } from "./parse-limits.js";
import type { CelSignature, FunctionMetadata } from "./signature.js";
import { formatSignature, parseSignature } from "./signature.js";
import { registerStandardLibrary, standardConstants } from "./standard-library.js";
import { standardConstantValues } from "./runtime-library.js";
import type { NominalResolver } from "./type-expression.js";
import { parseTypeExpression } from "./type-expression.js";

export interface CelEnvironmentOptions {
  /**
   * Whether a name nothing declares reads as `dyn` instead of being reported.
   *
   * The default is CEL's own answer — report it. A host that types only part of what an
   * expression may read turns it on, and a host that declares everything legal at a site
   * leaves it off so a misspelled name is caught.
   */
  readonly unlistedVariablesAreDyn?: boolean;
  /**
   * Whether a list or map literal must hold one type. The default is off, which is
   * CEL's: a heterogeneous literal is a `list<dyn>`, not a mistake.
   */
  readonly homogeneousAggregateLiterals?: boolean;
  /** Whether `.?`, `[?]` and the `optional` members exist. Off by default, as in CEL. */
  readonly enableOptionalTypes?: boolean;
  /**
   * Asked at every schema node, with the document the node belongs to, before its
   * structure is read. It answers a registered type name with its arguments, or the
   * document to read in place of the node — which is how a reference leaving the document
   * is resolved, the host owning what a reference outside this document is based on.
   */
  readonly resolveSchemaType?: SchemaTypeResolver;
  readonly limits?: Partial<CelParseLimits>;
  /** Whether the standard library is registered. On by default. */
  readonly standardLibrary?: boolean;
  /** How many compiled expressions this environment keeps. */
  readonly compiledCacheCapacity?: number;
}

export type TypeDeclaration =
  | string
  | CelType
  | { readonly fields: Readonly<Record<string, FieldDeclaration>> }
  | {
      readonly schema: JsonSchemaNode;
      /**
       * The document the schema belongs to — what a `#/…` reference inside it resolves
       * against. Absent where the schema **is** the document, which is the common case.
       */
      readonly document?: JsonSchemaNode;
    };

export interface VariableDefinition {
  readonly name: string;
  readonly type: CelType;
  readonly typeName: string;
  readonly description?: string;
  readonly constant: boolean;
}

export interface FunctionDefinition {
  readonly name: string;
  readonly signature: string;
  /** How the call is written: the receiver type, or null for a global call. */
  readonly receiverType: string | null;
  readonly parameters: readonly string[];
  readonly returns: string;
  readonly deterministic: boolean;
  readonly hostBacked: boolean;
  readonly throws?: readonly string[];
  readonly description?: string;
  readonly origin?: string;
}

export interface TypeDefinitionListing {
  readonly name: string;
  readonly base: string;
  readonly parameters: readonly string[];
  readonly description?: string;
}

export interface NamespaceListing {
  readonly name: string;
  readonly functions: readonly string[];
  /** Whether names beyond the listed ones are reachable; see {@link NamespaceOptions.open}. */
  readonly open: boolean;
}

export interface Definitions {
  readonly variables: readonly VariableDefinition[];
  readonly functions: readonly FunctionDefinition[];
  readonly types: readonly TypeDefinitionListing[];
  readonly namespaces: readonly NamespaceListing[];
}

/**
 * What converting one registration's schema could not judge.
 *
 * A schema node this engine has no rule for is reported rather than refused: the schema
 * is usually a third party's data, so throwing at registration would turn someone else's
 * schema into a crash, and typing it `dyn` quietly is the hole the report exists to close.
 * The consumer that knows where the schema was written is the one that can anchor a
 * diagnostic at it.
 */
export interface SchemaRegistrationReport {
  /** The name registered under. */
  readonly name: string;
  readonly unjudged: readonly UnjudgedSchemaNode[];
  /** Every reference re-entered on the descent: a recursive schema, deliberately `dyn`. */
  readonly recursive: readonly RecursiveSchemaReference[];
}

/**
 * A namespaced function a host declares, in one of two forms.
 *
 * **`signature`** declares it whole, in global form (`total(double, int): double`), and this
 * engine judges the call's arity and its argument types against it.
 *
 * **`name` + `returns`** declares the function's identity and its RESULT and **withholds the
 * parameter list**, so arity and arguments are judged by nobody here. A host whose own
 * signature grammar is richer than CEL's — an optional trailing parameter, a declared JSON
 * Schema per parameter — judges them itself and strictly better. The two forms are exclusive
 * by construction rather than by a flag: a declaration that carried parameters and asked for
 * them to be ignored would hold a list nothing reads, which no reader can tell from a list
 * that is simply wrong.
 *
 * **A type name this environment registers nothing under is accepted and reads `dyn`**, and
 * every call to such a function carries a ranged `CEL_TYPE_ERROR` naming it. A declaration
 * is a host's own data — a module function's declared result out of a manifest — so a typo
 * in one is the host disagreeing with its own registry, which is reported where there is a
 * range rather than thrown where there is none. A type registered AFTER a declaration naming
 * it does not change that declaration: a declaration resolves its types once, when it is
 * made.
 */
export type NamespaceFunctionDeclaration = (
  | { readonly signature: string; readonly name?: never; readonly returns?: never }
  | { readonly name: string; readonly returns: string | CelType; readonly signature?: never }
) & {
  readonly deterministic?: boolean;
  readonly hostBacked?: boolean;
  readonly throws?: readonly string[];
};

/** What a host says about a namespace as a whole. */
export interface NamespaceOptions {
  /**
   * Whether names beyond the declared ones are reachable through it. **Open** means a name
   * this namespace did not declare types `dyn` and is reported by nobody: the host resolves
   * it against vocabulary this engine does not hold — an export gate, a capability, a
   * re-export chain — and words that verdict itself. Closed (the default) makes such a name
   * `FUNCTION_UNRESOLVED`.
   */
  readonly open?: boolean;
}

interface VariableRecord {
  readonly type: CelType;
  readonly description?: string;
  readonly constant: boolean;
  /** What the schema it was typed from could not judge, where it was typed from one. */
  readonly unjudged?: readonly UnjudgedSchemaNode[];
  readonly recursive?: readonly RecursiveSchemaReference[];
}

/** A type a declaration named, beside what converting it could not judge. */
interface DeclaredType {
  readonly type: CelType;
  readonly unjudged?: readonly UnjudgedSchemaNode[];
  readonly recursive?: readonly RecursiveSchemaReference[];
}

/** How many compiled expressions an environment keeps when nothing says otherwise. */
export const DEFAULT_COMPILED_CACHE_CAPACITY = 256;

export class CelEnvironment {
  private readonly registry: FunctionRegistry;
  private readonly variables: Map<string, VariableRecord>;
  private readonly types: Map<string, RegisteredType>;
  private readonly namespaceFunctions: Map<string, Map<string, NamespaceFunction>>;
  /** Namespaces that declare only part of what they reach; see {@link NamespaceOptions.open}. */
  private readonly openNamespaces: Set<string>;
  private readonly constants: Map<string, CelValue>;
  /** Bounded: a source text is a key an author's input decides. */
  private readonly compiled: BoundedCache<string, CelProgram>;
  readonly options: Required<
    Pick<
      CelEnvironmentOptions,
      "unlistedVariablesAreDyn" | "homogeneousAggregateLiterals" | "enableOptionalTypes"
    >
  > &
    CelEnvironmentOptions;

  constructor(options: CelEnvironmentOptions = {}, inherited?: CelEnvironment) {
    this.options = {
      unlistedVariablesAreDyn: false,
      homogeneousAggregateLiterals: false,
      enableOptionalTypes: false,
      ...(inherited ? inherited.options : {}),
      ...options,
    };
    this.registry = new FunctionRegistry(inherited?.registry);
    this.variables = new Map(inherited?.variables);
    this.types = new Map(inherited?.types);
    this.namespaceFunctions = new Map();
    for (const [namespace, functions] of inherited?.namespaceFunctions ?? []) {
      this.namespaceFunctions.set(namespace, new Map(functions));
    }
    this.openNamespaces = new Set(inherited?.openNamespaces);
    this.constants = new Map(inherited?.constants);
    this.compiled = new BoundedCache(
      this.options.compiledCacheCapacity ?? DEFAULT_COMPILED_CACHE_CAPACITY,
    );
    if (inherited) return;
    if (this.options.standardLibrary ?? true) {
      for (const [name, value] of standardConstantValues(this.options.enableOptionalTypes)) {
        this.constants.set(name, value);
      }
      registerStandardLibrary(this.registry, {
        optionalTypes: this.options.enableOptionalTypes,
        resolveNominal: this.nominalResolver,
      });
      for (const constant of standardConstants(this.options.enableOptionalTypes)) {
        this.variables.set(constant.name, {
          type: constant.type,
          constant: true,
          ...(constant.description === undefined ? {} : { description: constant.description }),
        });
      }
    }
  }

  /** A new environment inheriting everything, which may then diverge. */
  clone(options: CelEnvironmentOptions = {}): CelEnvironment {
    return new CelEnvironment(options, this);
  }

  // --- registration -------------------------------------------------------

  /**
   * Registers a function, **replacing** any registration answering the same call.
   *
   * Every registration forgets what this environment compiled: a program holds the
   * overloads its call sites resolved to, so serving a cached one after the library
   * changed would run the function that was replaced — the precise failure the
   * replaceable library exists to avoid.
   */
  registerFunction(signature: string | CelSignature, metadata: FunctionMetadata = {}): this {
    this.registry.register(this.signatureOf(signature), metadata);
    this.compiled.clear();
    return this;
  }

  /** Removes the one registration answering that call. Answers whether it was there. */
  removeFunction(signature: string | CelSignature): boolean {
    const removed = this.registry.remove(this.signatureOf(signature));
    this.compiled.clear();
    return removed;
  }

  /** Removes every registration of a name, so a call to it is unknown. */
  removeFunctionsNamed(name: string): number {
    const removed = this.registry.removeName(name);
    this.compiled.clear();
    return removed;
  }

  /** Registers an operator over the types given, replacing one over the same types. */
  registerOperator(
    operator: string,
    parameters: readonly string[],
    returns: string,
    metadata: FunctionMetadata = {},
  ): this {
    this.registry.register(
      {
        name: operator,
        form: "global",
        parameters: parameters.map((text) => this.readType(text)),
        returns: this.readType(returns),
      },
      metadata,
    );
    this.compiled.clear();
    return this;
  }

  registerVariable(
    name: string,
    declaration: TypeDeclaration,
    metadata: { readonly description?: string } = {},
  ): this {
    this.variables.set(name, {
      ...this.typeOf(declaration),
      constant: false,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
    });
    // A declared name changes which NAME a dotted chain reads: `splitDeclaredChain` is
    // decided at compile time from the declarations, so a program compiled before this
    // call resolved the chain against the activation instead. Serving it afterwards is
    // the check/run divergence that split exists to prevent, arriving through the cache.
    this.compiled.clear();
    return this;
  }

  /** A name whose value never changes; it reads exactly as a variable does. */
  registerConstant(
    name: string,
    declaration: TypeDeclaration,
    metadata: { readonly description?: string } = {},
  ): this {
    this.variables.set(name, {
      ...this.typeOf(declaration),
      constant: true,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
    });
    this.compiled.clear();
    return this;
  }

  hasVariable(name: string): boolean {
    return this.variables.has(name);
  }

  /**
   * Every schema-typed registration whose schema this engine could not judge whole, with
   * each node by JSON Pointer. Empty is every node judged, which is the normal answer.
   */
  schemaReports(): readonly SchemaRegistrationReport[] {
    const reports: SchemaRegistrationReport[] = [];
    for (const [name, held] of [...this.variables.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const unjudged = held.unjudged ?? [];
      const recursive = held.recursive ?? [];
      if (unjudged.length === 0 && recursive.length === 0) continue;
      reports.push({ name, unjudged, recursive });
    }
    return reports;
  }

  /** Registers a named type, with every operator, conversion and member it declares. */
  registerType(definition: NominalTypeDefinition): this {
    // A value of a named type carries its name under the engine's own value key, so a
    // name the engine already uses there would make two types one value.
    if ((CEL_VALUE_KEYS as readonly string[]).includes(definition.name)) {
      throw new CelTypeRegistrationError(
        `${JSON.stringify(definition.name)} is the type key of a value this engine builds`,
      );
    }
    const registered = buildRegisteredType(definition, this.nominalResolver);
    this.types.set(definition.name, registered);
    const resolver: NominalResolver = (name, args) =>
      name === "Self" ? { ...registered.self, args: args.length > 0 ? args : registered.self.args } : this.nominalResolver(name, args);
    for (const signature of nominalSignatures(definition)) {
      this.registry.register(parseSignature(signature, resolver), {
        deterministic: true,
        origin: `type:${definition.name}`,
      });
    }
    for (const operator of nominalOperators(definition)) {
      this.registry.register(
        {
          name: operator.operator,
          form: "global",
          parameters: operator.parameters.map((text) => parseTypeExpression(text, resolver)),
          returns: parseTypeExpression(operator.returns, resolver),
        },
        { deterministic: true, origin: `type:${definition.name}` },
      );
    }
    this.compiled.clear();
    return this;
  }

  /**
   * Registers a namespace and the functions it declares. A namespace is a name that
   * denotes a module rather than a value, which is what turns `Alias.fn(x)` into a
   * qualified call rather than a method on something.
   */
  registerNamespace(
    name: string,
    functions: readonly (string | NamespaceFunctionDeclaration)[] = [],
    options: NamespaceOptions = {},
  ): this {
    normalizeNamespaces([name]);
    const declared = new Map<string, NamespaceFunction>();
    for (const declaration of functions) {
      const entry: NamespaceFunctionDeclaration =
        typeof declaration === "string" ? { signature: declaration } : declaration;
      const flags = {
        ...(entry.deterministic === undefined ? {} : { deterministic: entry.deterministic }),
        ...(entry.hostBacked === undefined ? {} : { hostBacked: entry.hostBacked }),
        ...(entry.throws === undefined ? {} : { throws: entry.throws }),
      };
      // A name this environment registers no type under is RECORDED and read as `dyn`,
      // never thrown: a namespace declaration is a host's own data — a module function's
      // declared result out of a manifest — so a typo there would otherwise be a crash
      // with no line, and the consumer that knows where it was written is the one that
      // can anchor the diagnostic. The checker reports it at each call.
      const unregistered: string[] = [];
      const resolver: NominalResolver = (named, args) => {
        const resolved = this.nominalResolver(named, args);
        if (resolved) return resolved;
        if (!unregistered.includes(named)) unregistered.push(named);
        return DYN;
      };
      const recorded = () => (unregistered.length > 0 ? { unregisteredTypes: [...unregistered] } : {});
      if (entry.signature !== undefined) {
        const signature = parseSignature(entry.signature, resolver);
        if (signature.form !== "global") {
          throw new CelTypeRegistrationError(
            `a namespaced function is declared without a receiver: ${JSON.stringify(entry.signature)}`,
          );
        }
        declared.set(signature.name, {
          name: signature.name,
          returns: signature.returns,
          parameters: signature.parameters,
          signature: formatSignature(signature),
          ...recorded(),
          ...flags,
        });
        continue;
      }
      declared.set(entry.name, {
        name: entry.name,
        returns:
          typeof entry.returns === "string" ? parseTypeExpression(entry.returns, resolver) : entry.returns,
        ...recorded(),
        ...flags,
      });
    }
    this.namespaceFunctions.set(name, declared);
    if (options.open === true) this.openNamespaces.add(name);
    else this.openNamespaces.delete(name);
    this.compiled.clear();
    return this;
  }

  /** Every namespace registered, in canonical order. */
  namespaces(): readonly string[] {
    return [...this.namespaceFunctions.keys()].sort();
  }

  // --- reading ------------------------------------------------------------

  /** Reads an expression against this environment's namespaces. */
  parse(source: string): CelExpression {
    return parseExpression(source, {
      namespaces: this.namespaces(),
      optionalSyntax: this.options.enableOptionalTypes,
      ...(this.options.limits ? { limits: this.options.limits } : {}),
    });
  }

  /**
   * Checks an expression. A tree resolved under a different namespace set is **refused**
   * rather than checked: its qualified calls are not the ones this environment would
   * have found, so every answer about it would be about a different expression.
   */
  check(source: string | CelExpression): CheckResult {
    const expression = typeof source === "string" ? this.parse(source) : source;
    if (typeof source !== "string" && !resolvedUnder(expression, this.namespaces())) {
      throw new CelEngineError(
        "namespaces_mismatch",
        `the expression was resolved under [${expression.namespaces.join(", ")}] and this environment has [${this.namespaces().join(", ")}]`,
      );
    }
    return checkExpression(expression, {
      registry: this.registry,
      variable: (name) => this.variables.get(name)?.type,
      declaredVariableNames: () => [...this.variables.keys()],
      namespaceFunction: (namespace, name) => this.namespaceFunctions.get(namespace)?.get(name),
      namespaceIsOpen: (namespace) => this.openNamespaces.has(namespace),
      options: {
        unlistedVariablesAreDyn: this.options.unlistedVariablesAreDyn,
        homogeneousAggregateLiterals: this.options.homogeneousAggregateLiterals,
        enableOptionalTypes: this.options.enableOptionalTypes,
      },
    });
  }

  /**
   * Compiles an expression into a program. Nothing is type-checked here — the checker
   * decides every verdict, and a consumer that wants one asks for it — so compiling
   * refuses only what cannot be compiled at all: a source that did not read whole.
   *
   * A compile from text is memoized in a bounded cache; a tree handed over directly is
   * compiled each time, because a tree has no identity to key on.
   */
  compile(source: string | CelExpression): CelProgram {
    if (typeof source !== "string") return this.compileExpressionNow(source);
    const held = this.compiled.get(source);
    if (held) return held;
    const program = this.compileExpressionNow(this.parse(source));
    this.compiled.set(source, program);
    return program;
  }

  /** Compiles and runs an expression against an activation. */
  evaluate(
    source: string | CelExpression,
    activation?: CelActivation,
    options?: EvaluateOptions,
  ): CelValue {
    return this.compile(source).evaluate(activation, options);
  }

  // --- the emitter ---------------------------------------------------------

  /**
   * The JavaScript module for a set of expressions, emitted now: its text, its key and its
   * integrity header. The same expressions in the same order against the same environment
   * emit byte-identically, so a host may compare two emissions instead of trusting one.
   *
   * The host stores and loads the text; this package touches no filesystem and exports no
   * loader. `emitterRuntime()` is what the loaded module's factory takes, and
   * `programsFromEmittedModule` verifies its header before anything runs.
   */
  emit(sources: readonly string[]): EmittedModule {
    return emitModule(this.target(), this.digest(), this.expressionsOf(sources));
  }

  /**
   * The module for a set of expressions, read from the store where it holds a copy whose
   * header matches and emitted and written where it does not — so a corrupted, stale or
   * foreign stored copy causes a recompile rather than a run.
   */
  emittedModule(sources: readonly string[], store: EmittedModuleStore): StoredEmittedModule {
    // The trees are handed over as a thunk: a hit reads a header and a digest, and parsing
    // every expression to find out whether it needed to is work with no answer attached.
    return storedEmittedModule(
      this.target(),
      this.digest(),
      sources,
      () => this.expressionsOf(sources),
      store,
    );
  }

  /** The runtime support library an emitted module's factory is handed. */
  emitterRuntime(): EmittedRuntime {
    return emitterRuntime(this.target());
  }

  /**
   * This environment's digest: the order-independent hash of its resolved listing, which
   * the key and the header are both over. A host that caches by key never needs it; a host
   * explaining a recompile does.
   */
  digest(): string {
    return environmentDigest(this);
  }

  private expressionsOf(sources: readonly string[]): readonly EmittedExpression[] {
    return sources.map((source) => ({ source, root: this.readyExpression(this.parse(source)).root }));
  }

  /** What the backends need of this environment, built one way for both of them. */
  private target(): CompileTarget {
    return {
      registry: this.registry,
      constants: this.constants,
      nominalArity: (name) => this.types.get(name)?.parameters.length,
      // The same declarations the checker splits a dotted chain on.
      declares: (name) => this.variables.has(name),
    };
  }

  /**
   * An expression a backend may compile: read whole, and resolved under this
   * environment's own namespaces. Nothing is type-checked — the checker decides every
   * verdict and a consumer that wants one asks for it.
   */
  private readyExpression(expression: CelExpression): CelExpression {
    if (expression.diagnostics.length > 0) {
      throw new CelEngineError(
        "unreadable_expression",
        `${JSON.stringify(expression.source)} could not be read: ${expression.diagnostics[0]!.message}`,
      );
    }
    if (!resolvedUnder(expression, this.namespaces())) {
      throw new CelEngineError(
        "namespaces_mismatch",
        `the expression was resolved under [${expression.namespaces.join(", ")}] and this environment has [${this.namespaces().join(", ")}]`,
      );
    }
    return expression;
  }

  private compileExpressionNow(expression: CelExpression): CelProgram {
    return compileExpression(this.readyExpression(expression), this.target());
  }

  /**
   * Whether a value of this type can be converted to text by the environment's own
   * `string()`. A consumer that renders a value into text asks this before it tries;
   * `dyn` passes, because only the runtime knows what it holds.
   */
  convertsToString(type: CelType): boolean {
    if (type.kind === "dyn") return true;
    return "resolved" in this.registry.resolve("string", "global", [type]);
  }

  /** Every registration, for a listing a host prints or compares. */
  definitions(): Definitions {
    return {
      variables: [...this.variables.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, held]) => ({
          name,
          type: held.type,
          typeName: formatType(held.type, true),
          constant: held.constant,
          ...(held.description === undefined ? {} : { description: held.description }),
        })),
      functions: this.registry.list().map((entry) => ({
        name: entry.signature.name,
        signature: formatSignature(entry.signature),
        receiverType: entry.signature.receiver ? formatType(entry.signature.receiver) : null,
        parameters: entry.signature.parameters.map((type) => formatType(type)),
        returns: formatType(entry.signature.returns),
        deterministic: entry.metadata.deterministic ?? true,
        hostBacked: entry.metadata.hostBacked ?? false,
        ...(entry.metadata.throws === undefined ? {} : { throws: entry.metadata.throws }),
        ...(entry.metadata.description === undefined ? {} : { description: entry.metadata.description }),
        ...(entry.metadata.origin === undefined ? {} : { origin: entry.metadata.origin }),
      })),
      types: [...this.types.values()].map((registered) => ({
        name: registered.definition.name,
        base: formatType(registered.base),
        parameters: registered.parameters,
        ...(registered.definition.description === undefined
          ? {}
          : { description: registered.definition.description }),
      })),
      namespaces: this.namespaces().map((name) => ({
        name,
        open: this.openNamespaces.has(name),
        // A declaration whose parameter list is withheld has no signature text, so it is
        // listed by what it DOES declare — its name and its result. Printing an invented
        // empty parameter list would read as a function of no arguments.
        functions: [...this.namespaceFunctions.get(name)!.values()].map(
          (held) => held.signature ?? `${held.name}(…): ${formatType(held.returns)}`,
        ),
      })),
    };
  }

  // --- types --------------------------------------------------------------

  private readonly nominalResolver: NominalResolver = (name, args) => {
    const registered = this.types.get(name);
    if (!registered) return undefined;
    if (args.length === 0) return registered.self;
    if (args.length !== registered.parameters.length) {
      throw new CelTypeRegistrationError(
        `${name} takes ${registered.parameters.length} type argument${registered.parameters.length === 1 ? "" : "s"}`,
      );
    }
    return { ...registered.self, args };
  };

  private readType(text: string): CelType {
    return parseTypeExpression(text, this.nominalResolver);
  }

  private signatureOf(signature: string | CelSignature): CelSignature {
    return typeof signature === "string" ? parseSignature(signature, this.nominalResolver) : signature;
  }

  /** The type a declaration names: a type expression, a field map, or a schema. */
  private typeOf(declaration: TypeDeclaration): DeclaredType {
    if (typeof declaration === "string") return { type: this.readType(declaration) };
    if ("kind" in declaration) return { type: declaration };
    if ("fields" in declaration) {
      return { type: fieldMapType(declaration.fields, (text) => this.readType(text)) };
    }
    if ("schema" in declaration) {
      const converted = schemaType(
        {
          node: declaration.schema,
          ...(declaration.document === undefined ? {} : { root: declaration.document }),
        },
        {
          ...(this.options.resolveSchemaType ? { resolveSchemaType: this.options.resolveSchemaType } : {}),
          lookupNamedType: (name, args) =>
            this.nominalResolver(
              name,
              args.map((text) => this.readType(text)),
            ),
        },
      );
      return {
        type: converted.type,
        ...(converted.unjudged.length === 0 ? {} : { unjudged: converted.unjudged }),
        ...(converted.recursive.length === 0 ? {} : { recursive: converted.recursive }),
      };
    }
    throw new CelTypeRegistrationError("a declaration is a type expression, a field map or a schema");
  }
}
