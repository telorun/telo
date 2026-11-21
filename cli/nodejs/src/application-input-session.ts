import { appendEnvFileValue, envFileDestination, type EnvFileEntry } from "@telorun/analyzer";
import { encodeSecretSeed, generateSecretSeed } from "@telorun/secret-seed";
import type { ApplicationInputResolver, UnresolvedApplicationInput } from "@telorun/kernel";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InputPrompter } from "./application-input-prompt.js";
import { readEnvFileIfPresent, warnIfNotIgnored } from "./env-file-writes.js";
import type { Logger } from "./logger.js";

/** One answer the person gave, with the entry it answers. */
export interface GivenAnswer {
  readonly input: UnresolvedApplicationInput;
  readonly value: string;
}

/** Where a seed the person agrees to generate is kept: the same places the
 *  answers' save offer writes to. */
export interface SeedOffer {
  /** Where the run read its env files from; `undefined` for a manifest that is a URL, which offers nothing. */
  directory: string | undefined;
  envFiles: readonly EnvFileEntry[];
  log: Logger;
}

/**
 * The answers of one `telo run` — one load, or every reload of a watch
 * session — keyed by declaration identity. A reload is answered from what was
 * given before; only an entry not answered yet, or one whose answer the kernel
 * refused, is asked.
 */
export class ApplicationInputSession {
  private readonly answers = new Map<string, string>();
  private fresh = new Map<string, GivenAnswer>();

  seedOffer?: SeedOffer;

  constructor(readonly prompter: InputPrompter) {}

  readonly resolve: ApplicationInputResolver = async (unresolved) => {
    const given = new Map<string, string>();
    const toAsk: UnresolvedApplicationInput[] = [];
    for (const input of unresolved) {
      const known = this.answers.get(input.id);
      if (known !== undefined && input.refusal === undefined) given.set(input.id, known);
      else if (input.generable) {
        const seed = await this.generateAndSave(input);
        if (seed === undefined) return undefined;
        given.set(input.id, seed);
        this.answers.set(input.id, seed);
      } else toAsk.push(input);
    }
    if (toAsk.length > 0 && this.prompter.askAll) {
      const values = await this.prompter.askAll(toAsk);
      if (values === undefined) return undefined;
      for (const input of toAsk) {
        const value = values.get(input.id);
        if (value === undefined) continue;
        given.set(input.id, value);
        this.answers.set(input.id, value);
        this.fresh.set(input.id, { input, value });
      }
      return given;
    }
    if (toAsk.length > 0 && toAsk.every((input) => input.refusal === undefined)) {
      this.prompter.say(
        `${toAsk.length === 1 ? "1 input has" : `${toAsk.length} inputs have`} no value — enter ` +
          `${toAsk.length === 1 ? "it" : "each"} below (an empty line is an empty value; Ctrl-D stops).`,
      );
    }
    for (const input of toAsk) {
      const value = await this.prompter.ask(input);
      if (value === null) return undefined;
      given.set(input.id, value);
      this.answers.set(input.id, value);
      this.fresh.set(input.id, { input, value });
    }
    return given;
  };

  /** Offer to make the value and keep it in the sensitive env file; generating
   *  and saving are one step, so nothing is used that is not saved. `undefined`
   *  when nothing can be offered or the person says no; a write that fails
   *  refuses the run naming the file. */
  private async generateAndSave(input: UnresolvedApplicationInput): Promise<string | undefined> {
    const offer = this.seedOffer;
    const name = input.env!;
    if (!offer || offer.directory === undefined) return undefined;
    const destination = envFileDestination(offer.envFiles, true);
    if ("refused" in destination) {
      this.prompter.say(`${destination.refused} ${name} is not generated.`);
      return undefined;
    }
    const target = path.join(offer.directory, destination.name);
    const question = `${name} is not set — generate one and save it to ${destination.name}?`;
    if (!(await this.prompter.confirm(question, { defaultYes: true }))) return undefined;
    const seed = encodeSecretSeed(generateSecretSeed());
    try {
      const edit = appendEnvFileValue(readEnvFileIfPresent(target) ?? "", name, seed);
      if (!edit.ok) throw new Error(edit.reason);
      fs.writeFileSync(target, edit.text);
    } catch (error) {
      throw new Error(`cannot save ${name} to ${target}: ${(error as Error).message}`);
    }
    this.prompter.say(`saved ${name} to ${destination.name}`);
    warnIfNotIgnored(target, offer.log);
    return seed;
  }

  /** The answers given since the last call — what a run offers to save once
   *  the kernel has accepted them. */
  takeFresh(): GivenAnswer[] {
    const fresh = [...this.fresh.values()];
    this.fresh = new Map();
    return fresh;
  }
}

export interface SaveAnswersOptions {
  /** Where the run read its env files from; `undefined` for a manifest that
   *  is a URL, for which nothing is offered. */
  directory: string | undefined;
  /** The `env.files` entries in force for that directory. */
  envFiles: readonly EnvFileEntry[];
  prompter: InputPrompter;
  log: Logger;
}

/**
 * Offer once to write `answers` to the run's env files — a sensitive one to the
 * last sensitive `env.files` entry, every other to the last that is not, as
 * `telo env template --write` places them — and write them, uncommented, only
 * when the person says yes. Existing lines are never rewritten; each value is
 * appended spelled so the env reader gives it back unchanged, and one no
 * spelling reproduces is named and left out.
 */
export async function offerToSaveAnswers(answers: readonly GivenAnswer[], options: SaveAnswersOptions): Promise<void> {
  const { directory, envFiles, prompter, log } = options;
  const savable = answers.filter((answer) => answer.input.env !== undefined);
  if (directory === undefined || savable.length === 0) return;
  const plan: Array<{ file: string; sensitive: boolean; answers: GivenAnswer[] }> = [];
  for (const sensitive of [false, true]) {
    const own = savable.filter((answer) => answer.input.sensitive === sensitive);
    if (own.length === 0) continue;
    const destination = envFileDestination(envFiles, sensitive);
    if ("refused" in destination) {
      prompter.say(`${destination.refused} Not saving ${names(own)}.`);
      continue;
    }
    plan.push({ file: destination.name, sensitive, answers: own });
  }
  if (plan.length === 0) return;
  const where = plan.map((entry) => `${names(entry.answers)} to ${entry.file}`).join(" and ");
  if (!(await prompter.confirm(`Save ${where}?`))) return;

  for (const { file, sensitive, answers: own } of plan) {
    const target = path.join(directory, file);
    let text = readEnvFileIfPresent(target) ?? "";
    const saved: string[] = [];
    for (const { input, value } of own) {
      const edit = appendEnvFileValue(text, input.env!, value);
      if (!edit.ok) {
        prompter.say(`${input.env} is not saved: ${edit.reason}`);
        continue;
      }
      text = edit.text;
      saved.push(input.env!);
    }
    if (saved.length === 0) continue;
    fs.writeFileSync(target, text);
    prompter.say(`saved ${saved.join(", ")} to ${path.relative(process.cwd(), target) || target}`);
    if (sensitive) warnIfNotIgnored(target, log);
  }
}

function names(answers: readonly GivenAnswer[]): string {
  return answers.map((answer) => answer.input.env).join(", ");
}

/** The hint a refusal for missing values carries when nothing could ask —
 *  because there is no terminal, or because `--no-input` said not to. */
export function unresolvedInputsHint(
  unresolved: readonly UnresolvedApplicationInput[],
  declined: boolean,
): string {
  const asked = unresolved.filter((input) => !input.generable);
  const generable = unresolved.filter((input) => input.generable);
  const ask = declined ? "run without `--no-input` to be asked" : "run in a terminal to be asked";
  const generate = declined
    ? "run in a terminal without `--no-input` to have one generated and saved"
    : "run in a terminal to have one generated and saved";
  const sentences: string[] = [];
  if (asked.length > 0) {
    const listed = asked.map((input) => input.env ?? input.id).join(", ");
    sentences.push(
      `${listed} ${asked.length === 1 ? "has" : "have"} no value: ${ask}, ` +
        "or write them with `telo env template --write`.",
    );
  }
  for (const input of generable) {
    sentences.push(
      `${input.env ?? input.id} has no value: ${generate}, or set it to 32 random bytes as unpadded base64url.`,
    );
  }
  return sentences.join(" ");
}
