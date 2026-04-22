/** Classic Wagner-Fischer Levenshtein distance. Iterative with two rolling rows
 *  so memory is O(min(a, b)); sufficient for short strings like resource kind
 *  identifiers (a few dozen characters at most). */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure b is the shorter string so the row buffer stays small.
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,      // insertion
        prev[j] + 1,          // deletion
        prev[j - 1] + cost,   // substitution
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[b.length];
}
