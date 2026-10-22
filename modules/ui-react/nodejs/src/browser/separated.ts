/** What was typed, as the values a comma separates. */
export const separated = (text: string): string[] =>
  text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
