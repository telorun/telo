/**
 * What a path template reads: its `{name}` variables, or why it is no template.
 * The one reader of the grammar, for `x-telo-path-params-for`,
 * `x-telo-context-from-path-template` and the `path-template` format alike.
 *
 * A template is an app-relative path or an `http://`, `https://` or `mailto:`
 * address whose variables are whole path segments `{<name>}`, `<name>` matching
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`, each named once; an absolute URL's authority, its
 * query and its fragment hold none. Browser-safe, and imports nothing.
 */

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ABSOLUTE_URL = /^(https?):\/\/([^/?#]*)((?:[/?#].*)?)$/i;
const MAILTO = /^mailto:(.*)$/i;
const BRACE = /[{}]/;

/** What a template reads: its variables in order, or why it is no template and
 *  the zero-based offset in the template the reason is about. */
export type PathTemplateReading =
  | { readonly variables: readonly string[] }
  | { readonly invalid: string; readonly offset: number };

/** A path template's variables, or the reason it is not one. */
export function readPathTemplate(template: string): PathTemplateReading {
  let rest = template;
  let restAt = 0;
  const absolute = ABSOLUTE_URL.exec(template);
  if (absolute) {
    const authority = absolute[2]!;
    const authorityAt = absolute[1]!.length + 3;
    const brace = authority.search(BRACE);
    if (brace !== -1) {
      return {
        invalid: `its authority '${authority}' holds a variable — only the path segments after the authority are variables`,
        offset: authorityAt + brace,
      };
    }
    rest = absolute[3]!;
    restAt = authorityAt + authority.length;
  } else {
    const mailto = MAILTO.exec(template);
    if (mailto) {
      rest = mailto[1]!;
      restAt = template.length - rest.length;
    }
  }
  const tailAt = rest.search(/[?#]/);
  const path = tailAt === -1 ? rest : rest.slice(0, tailAt);
  const tail = tailAt === -1 ? "" : rest.slice(tailAt);
  const tailBrace = tail.search(BRACE);
  if (tailBrace !== -1) {
    return {
      invalid: `its query or fragment '${tail}' holds '{' or '}' — a variable is a whole path segment`,
      offset: restAt + tailAt + tailBrace,
    };
  }
  const variables: string[] = [];
  let segmentAt = restAt;
  for (const segment of path.split("/")) {
    const at = segmentAt;
    segmentAt += segment.length + 1;
    if (!BRACE.test(segment)) continue;
    const whole = /^\{([^{}]*)\}$/.exec(segment);
    if (!whole) {
      return {
        invalid: `segment '${segment}' holds a variable beside other text — a variable is a whole segment, '/{<name>}/'`,
        offset: at,
      };
    }
    const name = whole[1]!;
    if (!VARIABLE_NAME.test(name)) {
      return { invalid: `'{${name}}' names no variable — a name matches /^[A-Za-z_][A-Za-z0-9_]*$/`, offset: at };
    }
    if (variables.includes(name)) {
      return { invalid: `'{${name}}' appears twice — each variable names one segment`, offset: at };
    }
    variables.push(name);
  }
  return { variables };
}
