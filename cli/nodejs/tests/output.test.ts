import { describe, expect, it } from "vitest";
import {
  OUTPUT_FORMATS,
  Output,
  type OutputFormat,
  type OutputStream,
  parseOutputFormat,
} from "../src/output.js";

/** A recording stream. The whole point of `Output` taking its streams as
 *  constructor arguments is that a test can hand it these instead of spying on
 *  process globals. */
function recorder(isTTY = false): OutputStream & { text: string } {
  return {
    isTTY,
    text: "",
    write(chunk: string) {
      this.text += chunk;
      return true;
    },
  };
}

function build(format: OutputFormat, opts: { outTTY?: boolean; errTTY?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const stdout = recorder(opts.outTTY ?? false);
  const stderr = recorder(opts.errTTY ?? false);
  const out = new Output({ format, stdout, stderr, env: opts.env ?? {} });
  return { out, stdout, stderr };
}

describe("Output", () => {
  describe("stream discipline", () => {
    it.each(OUTPUT_FORMATS)("writes prose to stderr in %s format", (format) => {
      // stderr is the human surface in BOTH formats. Suppressing it under json
      // swallowed every failure reason a command reported through prose.
      const { out, stderr } = build(format);
      out.errLine("could not reach the hub");
      expect(stderr.text).toBe("could not reach the hub\n");
    });

    it("writes prose to stdout in text format", () => {
      const { out, stdout } = build("text");
      out.line("✓  No issues found");
      expect(stdout.text).toBe("✓  No issues found\n");
    });

    it("suppresses stdout prose under json, so the payload stands alone", () => {
      const { out, stdout } = build("json");
      out.line("✓  No issues found");
      out.emit({ ok: true });
      expect(JSON.parse(stdout.text)).toEqual({ ok: true });
    });
  });

  describe("emit", () => {
    it("is a no-op in text format", () => {
      const { out, stdout } = build("text");
      out.emit({ ok: true });
      expect(stdout.text).toBe("");
    });

    it("produces exactly one parseable document on stdout", () => {
      const { out, stdout } = build("json");
      out.emit({ ok: false, errorCount: 2 });
      expect(stdout.text.trimEnd().split("\n").length).toBeGreaterThan(0);
      expect(JSON.parse(stdout.text)).toEqual({ ok: false, errorCount: 2 });
    });
  });

  describe("document", () => {
    it.each(OUTPUT_FORMATS)("writes in %s format, since --json predates -o", (format) => {
      // The per-command `--json` flags must keep working under the default
      // text format, so a bare document is unconditional.
      const { out, stdout } = build(format);
      out.document(["0.1.0", "0.2.0"]);
      expect(JSON.parse(stdout.text)).toEqual(["0.1.0", "0.2.0"]);
    });

    it("shares one encoding with emit", () => {
      const a = build("json");
      a.out.emit({ x: 1 });
      const b = build("json");
      b.out.document({ x: 1 });
      expect(b.stdout.text).toBe(a.stdout.text);
    });
  });

  describe("colour", () => {
    it("decides per stream rather than once for the process", () => {
      // The original bug: colour read from stdout while diagnostics went to
      // stderr, so redirecting one and not the other emitted unrenderable escapes.
      const { out } = build("text", { outTTY: true, errTTY: false });
      expect(out.stdout.error("boom")).toContain("\x1b[");
      expect(out.stderr.error("boom")).toBe("boom");
    });

    it("never colours stdout under json, whatever FORCE_COLOR says", () => {
      const { out } = build("json", { outTTY: true, env: { FORCE_COLOR: "1" } });
      expect(out.stdout.error("boom")).toBe("boom");
    });

    it("keeps stderr colour under json, because stderr stays human-facing", () => {
      const { out } = build("json", { errTTY: true, env: { FORCE_COLOR: "1" } });
      expect(out.stderr.error("boom")).toContain("\x1b[");
    });

    it("honours NO_COLOR on a TTY", () => {
      const { out } = build("text", { outTTY: true, env: { NO_COLOR: "1" } });
      expect(out.stdout.ok("fine")).toBe("fine");
    });
  });

  describe("parseOutputFormat", () => {
    it.each(OUTPUT_FORMATS)("accepts %s", (format) => {
      expect(parseOutputFormat(format)).toBe(format);
    });

    it("throws rather than degrading an unknown format to text", () => {
      // Silently falling back is the worst failure a format flag can have: the
      // day `yaml` joins the enum, forgetting this function would make
      // `-o yaml` quietly print text.
      expect(() => parseOutputFormat("yaml")).toThrow(/Unsupported --output format 'yaml'/);
    });
  });
});
