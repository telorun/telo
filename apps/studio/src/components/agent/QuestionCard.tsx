import { useState } from "react";
import { Check, PenLine, Sparkles } from "lucide-react";
import type { AgentQuestion } from "@/agent";
import { formatAnswers } from "@/agent";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** What the user picked for one question. `custom` carries no text of its own:
 *  the typed answer lives beside it, so switching to an option and back does
 *  not lose what was written. */
type Choice = { kind: "option"; label: string } | { kind: "custom" };

/**
 * The agent's questions, as options the user clicks instead of types.
 *
 * Every question also takes an answer in the user's own words — the options are
 * the agent's guesses at the useful answers, not the set of legal ones, and a
 * card that only accepted them would make the agent's imagination the limit of
 * what can be built.
 *
 * Answering sends an ordinary chat message (the questions with their answers,
 * as prose) — the model is never told a card exists, so a user who turns the
 * cards off, or a client that never had them, answers the identical question by
 * typing and the agent behaves the same either way.
 */
export function QuestionCard({
  questions,
  interactive,
  onAnswer,
}: {
  questions: AgentQuestion[];
  /** False for a past turn or while one is running — the options are shown, but
   *  answering them again would address a question the agent has moved past. */
  interactive: boolean;
  onAnswer: (message: string) => void;
}) {
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  const answerFor = (question: AgentQuestion): string => {
    const picked = choice[question.id];
    if (!picked) return "";
    return picked.kind === "option" ? picked.label : (custom[question.id] ?? "").trim();
  };
  const answers = Object.fromEntries(questions.map((q) => [q.id, answerFor(q)]));
  const answered = questions.every((q) => answers[q.id]);

  const pick = (id: string, next: Choice) => setChoice((prev) => ({ ...prev, [id]: next }));
  const writeCustom = (id: string, text: string) => {
    setCustom((prev) => ({ ...prev, [id]: text }));
    setChoice((prev) => ({ ...prev, [id]: { kind: "custom" } }));
  };
  const useRecommended = () =>
    setChoice((prev) => {
      const next = { ...prev };
      for (const q of questions) {
        if (next[q.id]) continue;
        const recommended = q.options.find((o) => o.recommended);
        if (recommended) next[q.id] = { kind: "option", label: recommended.label };
      }
      return next;
    });
  const send = () => onAnswer(formatAnswers(questions, answers));

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      {questions.map((question, index) => {
        const picked = choice[question.id];
        // An OPEN question has no options to click — it asks for a fact only the
        // user has — so it opens straight into the field rather than hiding it
        // behind a "Something else…" that is the only choice.
        const open = question.options.length === 0;
        const writing = open || picked?.kind === "custom";
        return (
          <div key={question.id} className="flex flex-col gap-1.5">
            <div className="text-sm font-medium">
              <span className="mr-1.5 text-muted-foreground">{index + 1}.</span>
              {question.question}
            </div>
            <div className="flex flex-col gap-1">
              {question.options.map((option) => {
                const selected = picked?.kind === "option" && picked.label === option.label;
                return (
                  <Button
                    key={option.label}
                    variant={selected ? "default" : "outline"}
                    size="sm"
                    disabled={!interactive}
                    onClick={() => pick(question.id, { kind: "option", label: option.label })}
                    className={cn(
                      "h-auto w-full flex-col items-start gap-0.5 py-1.5 text-left whitespace-normal",
                      !interactive && "disabled:opacity-70",
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      {selected && <Check className="size-3 shrink-0" />}
                      <span className="font-medium">{option.label}</span>
                      {option.recommended && !selected && (
                        <Badge variant="secondary" className="ml-auto">
                          Recommended
                        </Badge>
                      )}
                    </span>
                    {option.detail && (
                      <span
                        className={cn(
                          "text-xs font-normal",
                          selected ? "text-primary-foreground/80" : "text-muted-foreground",
                        )}
                      >
                        {option.detail}
                      </span>
                    )}
                  </Button>
                );
              })}

              {interactive &&
                (writing ? (
                  <Input
                    // Autofocus is the click's own continuation: the button is
                    // replaced by the field it opened, so focus has to follow.
                    // An open question opens with the card, so nothing was
                    // clicked and focus stays where the user put it.
                    autoFocus={!open}
                    value={custom[question.id] ?? ""}
                    onChange={(e) => writeCustom(question.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (answered) send();
                    }}
                    placeholder={open ? "Your answer" : "Your own answer"}
                    aria-label={`${open ? "Answer" : "Your own answer"} to "${question.question}"`}
                    className="h-8 text-sm"
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => pick(question.id, { kind: "custom" })}
                    className="h-auto w-full justify-start py-1.5 text-muted-foreground"
                  >
                    <PenLine className="size-3" />
                    Something else…
                  </Button>
                ))}
            </div>
          </div>
        );
      })}

      {interactive && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <Button variant="secondary" size="sm" onClick={useRecommended}>
            <Sparkles className="size-3" />
            Use recommended
          </Button>
          <Button
            size="sm"
            disabled={!answered}
            onClick={send}
            title={answered ? undefined : "Answer every question first"}
          >
            Send answers
          </Button>
        </div>
      )}
    </div>
  );
}
