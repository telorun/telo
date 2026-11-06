/** A topic: dot-separated segments of `[a-z0-9_-]`, at most 128 bytes. */
export const TOPIC_MAX_BYTES = 128;
const TOPIC = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
/** A pattern: segments or `*` (one segment), the last possibly `>` (one or more). */
const TOPIC_PATTERN = /^(?:(?:[a-z0-9_-]+|\*)\.)*(?:[a-z0-9_-]+|\*|>)$/;

export function isTopic(value: unknown): value is string {
  return typeof value === "string" && value.length <= TOPIC_MAX_BYTES && TOPIC.test(value);
}

export function isTopicPattern(value: unknown): value is string {
  return typeof value === "string" && value.length <= TOPIC_MAX_BYTES && TOPIC_PATTERN.test(value);
}

/** Whether `topic` matches `pattern`: `*` stands for one segment, a final `>`
 *  for one or more. */
export function topicMatches(pattern: string, topic: string): boolean {
  const wanted = pattern.split(".");
  const actual = topic.split(".");
  for (let index = 0; index < wanted.length; index++) {
    const segment = wanted[index];
    if (segment === ">") return index === wanted.length - 1 && actual.length > index;
    if (index >= actual.length) return false;
    if (segment !== "*" && segment !== actual[index]) return false;
  }
  return wanted.length === actual.length;
}
