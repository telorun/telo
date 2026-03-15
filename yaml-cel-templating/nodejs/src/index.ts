import { evaluate as evaluateCEL } from "@marcbachmann/cel-js";
import AjvModule from "ajv";
const Ajv = (AjvModule as any).default ?? AjvModule;

/**
 * Type definitions for the templating engine
 */

export interface DirectiveMapping {
  for: string;
  do: string;
  if: string;
  then: string;
  else: string;
  let: string;
  eval: string;
  schema: string;
  assert: string;
  msg: string;
  include: string;
  with: string;
  key: string;
  value: string;
}

const DEFAULT_DIRECTIVES: DirectiveMapping = {
  for: "$for",
  do: "$do",
  if: "$if",
  then: "$then",
  else: "$else",
  let: "$let",
  eval: "$eval",
  schema: "$schema",
  assert: "$assert",
  msg: "$msg",
  include: "$include",
  with: "$with",
  key: "$key",
  value: "$value",
};

interface CompileContext {
  variables: Map<string, any>;
  directives: DirectiveMapping;
  directiveValues: Set<string>;
  schema?: any;
  parentPath: string;
  evaluateStringExpressions: boolean;
  lenientExpressions: boolean;
}

interface CompileOptions {
  context?: Record<string, any>;
  directives?: Partial<DirectiveMapping>;
  evaluateStringExpressions?: boolean;
  lenientExpressions?: boolean;
}

/**
 * Main compile function - entry point for the templating engine
 */
export function compile(record: any, options?: CompileOptions): any {
  const directives = { ...DEFAULT_DIRECTIVES, ...options?.directives };
  const directiveValues = new Set(Object.values(directives));
  const context: CompileContext = {
    variables: new Map(Object.entries(options?.context || {})),
    directives,
    directiveValues,
    parentPath: "$",
    evaluateStringExpressions: options?.evaluateStringExpressions ?? false,
    lenientExpressions: options?.lenientExpressions ?? false,
  };

  return compileValue(record, context);
}

/**
 * Core recursive compiler function
 */
function compileValue(value: any, context: CompileContext): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return compileArray(value, context);
  }

  if (typeof value === "object" && value !== null) {
    return compileObject(value, context);
  }

  if (typeof value === "string" && context.evaluateStringExpressions) {
    return compileString(value, context);
  }

  return value;
}

/**
 * Compile array values
 */
function compileArray(arr: any[], context: CompileContext): any {
  const result: any[] = [];
  const d = context.directives;

  for (const item of arr) {
    if (isDirectiveObject(item, context.directiveValues) && d.for in item) {
      const forResults = handleForDirective(item, context, "array");
      if (Array.isArray(forResults)) {
        result.push(...forResults);
      } else {
        result.push(forResults);
      }
    } else {
      result.push(compileValue(item, context));
    }
  }

  return result;
}

/**
 * Compile object with directive processing
 */
function compileObject(obj: any, parentContext: CompileContext): any {
  const d = parentContext.directives;

  // Step 1: Process schema directive first to validate parent scope data
  let schema: any = undefined;
  if (d.schema in obj) {
    schema = obj[d.schema];
    validateAgainstSchema(parentContext.variables, schema, parentContext.parentPath);
  }

  // Create child context with updated schema
  const context: CompileContext = {
    ...parentContext,
    variables: new Map(parentContext.variables),
    schema: schema,
    parentPath: parentContext.parentPath,
  };

  // Step 2: Process let directive - add variables to context
  if (d.let in obj) {
    const letVars = obj[d.let];
    for (const [key, expr] of Object.entries(letVars as Record<string, any>)) {
      try {
        const value = evaluateExpression(expr, context);
        context.variables.set(key, value);
      } catch (error) {
        throw new Error(
          `Error evaluating ${d.let} variable "${key}" at "${context.parentPath}": ${error}`,
        );
      }
    }
  }

  // Step 3: Process assert directive
  if (d.assert in obj) {
    const assertion = obj[d.assert];
    try {
      const result = evaluateCEL(assertion, Object.fromEntries(context.variables));
      if (!result) {
        const msg = obj[d.msg] || `Assertion failed: ${assertion}`;
        throw new Error(msg);
      }
    } catch (error) {
      throw new Error(`Assertion failed at "${context.parentPath}": ${error}`);
    }
  }

  // Step 4: Process if/then/else directives
  if (d.if in obj) {
    const hasDataKeys = Object.keys(obj).some((key) => !context.directiveValues.has(key));
    if (hasDataKeys) {
      const baseResult: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (context.directiveValues.has(key)) {
          continue;
        }
        const childPath = `${context.parentPath}.${key}`;
        const childContext: CompileContext = {
          ...context,
          parentPath: childPath,
        };
        baseResult[key] = compileValue(value, childContext);
      }

      const conditionalResult = handleIfDirective(obj, context);
      if (
        conditionalResult &&
        typeof conditionalResult === "object" &&
        !Array.isArray(conditionalResult)
      ) {
        return { ...baseResult, ...conditionalResult };
      }

      if (conditionalResult === undefined) {
        return baseResult;
      }

      return conditionalResult;
    }

    return handleIfDirective(obj, context);
  }

  // Step 5: Process for/do directives
  if (d.for in obj) {
    return handleForDirective(obj, context, "object");
  }

  // Step 6: Process eval directive — explicit evaluation
  if (d.eval in obj) {
    const evalValue = obj[d.eval];
    if (typeof evalValue === "string") {
      return compileString(evalValue, context);
    }
    return evalValue;
  }

  // Step 6b: Process key/value directives (used in for/do for dynamic keys)
  if (d.key in obj && d.value in obj) {
    const keyContext: CompileContext = { ...context, parentPath: `${context.parentPath}.${d.key}` };
    const valueContext: CompileContext = {
      ...context,
      parentPath: `${context.parentPath}.${d.value}`,
    };
    return {
      $key: compileValue(obj[d.key], keyContext),
      $value: compileValue(obj[d.value], valueContext),
    };
  }

  // Step 7: Process include/with directives
  if (d.include in obj) {
    throw new Error(`${d.include} directive not yet implemented`);
  }

  // Step 8: Compile regular keys
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip directive keys
    if (context.directiveValues.has(key)) {
      continue;
    }

    const childPath = `${context.parentPath}.${key}`;
    const childContext: CompileContext = {
      ...context,
      parentPath: childPath,
    };

    result[key] = compileValue(value, childContext);
  }

  return result;
}

/**
 * Compile string with interpolation support
 */
function compileString(str: string, context: CompileContext): any {
  const matches = Array.from(str.matchAll(/\$\{\{([^}]+)\}\}/g));

  if (matches.length === 0) {
    return str;
  }

  // If the entire string is a single interpolation, return the value type
  if (matches.length === 1 && matches[0][0] === str) {
    const expr = matches[0][1] as string;
    try {
      const value = evaluateCEL(expr, Object.fromEntries(context.variables));
      if (value === undefined) {
        if (context.lenientExpressions) return str;
        throw new Error(`Undefined variable "${expr}"`);
      }
      return value;
    } catch (error) {
      if (context.lenientExpressions) return str;
      throw new Error(
        `Error evaluating interpolation "${expr}" at "${context.parentPath}": ${error}`,
      );
    }
  }

  // Otherwise, concatenate all parts as strings
  let result = str;
  for (const match of matches) {
    const expr = match[1] as string;
    try {
      const value = evaluateCEL(expr, Object.fromEntries(context.variables));
      if (value === undefined) {
        if (context.lenientExpressions) continue;
        throw new Error(`Undefined variable "${expr}"`);
      }
      result = result.replace(match[0], String(value));
    } catch (error) {
      if (context.lenientExpressions) continue;
      throw new Error(
        `Error evaluating interpolation "${expr}" at "${context.parentPath}": ${error}`,
      );
    }
  }

  return result;
}

/**
 * Handle if/then/else directive
 */
function handleIfDirective(obj: any, context: CompileContext): any {
  const d = context.directives;
  const condition = obj[d.if];

  try {
    const result = evaluateCEL(condition, Object.fromEntries(context.variables));

    if (result && d.then in obj) {
      return compileValue(obj[d.then], context);
    } else if (!result && d.else in obj) {
      return compileValue(obj[d.else], context);
    } else if (result) {
      return undefined;
    }
  } catch (error) {
    throw new Error(
      `Error evaluating ${d.if} condition "${condition}" at "${context.parentPath}": ${error}`,
    );
  }

  return undefined;
}

/**
 * Handle for/do directive
 */
function handleForDirective(obj: any, context: CompileContext, mode: "array" | "object"): any {
  const d = context.directives;
  const forExpr = obj[d.for];
  const doTemplate = obj[d.do];

  if (!doTemplate) {
    throw new Error(`Missing ${d.do} in ${d.for} directive at "${context.parentPath}"`);
  }

  const forMatch = forExpr.match(/^(.+?)\s+in\s+(.+)$/);
  if (!forMatch) {
    throw new Error(
      `Invalid ${d.for} syntax "${forExpr}" at "${context.parentPath}". Expected "item in collection" or "key, val in map"`,
    );
  }

  const iteratorPart = forMatch[1].trim();
  const collectionExpr = forMatch[2].trim();

  try {
    const collection = evaluateCEL(collectionExpr, Object.fromEntries(context.variables));
    const results: any[] = [];

    if (Array.isArray(collection)) {
      const itemName = iteratorPart;
      for (const item of collection) {
        const itemContext: CompileContext = {
          ...context,
          variables: new Map(context.variables),
        };
        itemContext.variables.set(itemName, item);
        results.push(compileValue(doTemplate, itemContext));
      }
    } else if (typeof collection === "object" && collection !== null) {
      const [keyName, valName] = iteratorPart.split(",").map((s: string) => s.trim());
      if (!valName) {
        throw new Error(
          `Invalid map iterator "${iteratorPart}" at "${context.parentPath}". Expected "key, val"`,
        );
      }

      for (const [key, val] of Object.entries(collection)) {
        const itemContext: CompileContext = {
          ...context,
          variables: new Map(context.variables),
        };
        itemContext.variables.set(keyName, key);
        itemContext.variables.set(valName, val);
        results.push(compileValue(doTemplate, itemContext));
      }
    } else {
      throw new Error(
        `Collection in ${d.for} must be array or object, got ${typeof collection} at "${context.parentPath}"`,
      );
    }

    if (mode === "array") {
      return results;
    }

    const merged: Record<string, any> = {};
    for (const item of results) {
      if (item && typeof item === "object" && "$key" in item && "$value" in item) {
        merged[item["$key"]] = item["$value"];
      } else if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`Object-mode ${d.for} must produce objects at "${context.parentPath}"`);
      } else {
        Object.assign(merged, item);
      }
    }
    return merged;
  } catch (error) {
    throw new Error(`Error in ${d.for} directive at "${context.parentPath}": ${error}`);
  }
}

/**
 * Validate object against schema
 */
function validateAgainstSchema(variables: Map<string, any>, schema: any, path: string): void {
  const ajv = new Ajv();

  const jsonSchema: any = {
    type: "object",
    properties: {},
  };

  for (const [key, constraint] of Object.entries(schema as Record<string, any>)) {
    jsonSchema.properties[key] = normalizeSchemaConstraint(constraint);
  }

  const validate = ajv.compile(jsonSchema);
  const data = Object.fromEntries(variables);

  if (!validate(data)) {
    const errors = validate.errors
      ?.map((e: any) => `${e.instancePath || "/"}: ${e.message}`)
      .join("; ");
    throw new Error(`Schema validation failed at "${path}": ${errors}`);
  }
}

function normalizeSchemaConstraint(constraint: any): any {
  if (typeof constraint === "string") {
    return { type: constraint };
  }

  if (typeof constraint === "object" && constraint !== null) {
    return constraint;
  }

  return {};
}

/**
 * Check if an object contains directive keys
 */
function isDirectiveObject(obj: any, directiveValues: Set<string>): boolean {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  return Object.keys(obj).some((key) => directiveValues.has(key));
}

function evaluateExpression(expr: any, context: CompileContext): any {
  const d = context.directives;
  // Handle eval objects (e.g. from let values)
  if (typeof expr === "object" && expr !== null && d.eval in expr) {
    const evalValue = expr[d.eval];
    if (typeof evalValue === "string") {
      return compileString(evalValue, context);
    }
    return evalValue;
  }

  if (typeof expr !== "string") {
    return expr;
  }

  const trimmed = expr.trim();
  const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
  const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const isQuoted = isSingleQuoted || isDoubleQuoted;

  if (isQuoted) {
    return trimmed.slice(1, -1);
  }

  return evaluateCEL(expr, Object.fromEntries(context.variables));
}

/**
 * Export types
 */
export { CompileContext, CompileOptions };
