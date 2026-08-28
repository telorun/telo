import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionCard } from "./QuestionCard";
import type { AgentQuestion } from "@/agent";

afterEach(() => {
  cleanup();
});

const QUESTIONS: AgentQuestion[] = [
  {
    id: "surface",
    question: "What should this expose?",
    options: [
      { label: "HTTP API", detail: "routes on a server port", recommended: true },
      { label: "Scheduled job", detail: "runs on a cron" },
    ],
  },
  {
    id: "store",
    question: "Where does the data live?",
    options: [
      { label: "SQLite file", recommended: true },
      { label: "Postgres" },
    ],
  },
];

describe("QuestionCard", () => {
  it("sends the picked options as prose", async () => {
    const onAnswer = vi.fn();
    render(<QuestionCard questions={QUESTIONS} interactive onAnswer={onAnswer} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Scheduled job/ }));
    await user.click(screen.getByRole("button", { name: /Postgres/ }));
    await user.click(screen.getByRole("button", { name: "Send answers" }));

    expect(onAnswer).toHaveBeenCalledWith(
      "- What should this expose? — Scheduled job\n- Where does the data live? — Postgres",
    );
  });

  // The options are the agent's guesses at the useful answers, not the legal
  // ones — an answer outside them has to reach the model verbatim.
  it("sends an answer written in the user's own words", async () => {
    const onAnswer = vi.fn();
    render(<QuestionCard questions={QUESTIONS} interactive onAnswer={onAnswer} />);
    const user = userEvent.setup();

    await user.click(screen.getAllByRole("button", { name: /Something else/ })[0]);
    await user.type(
      screen.getByLabelText('Your own answer to "What should this expose?"'),
      "A gRPC service",
    );
    await user.click(screen.getByRole("button", { name: /SQLite file/ }));
    await user.click(screen.getByRole("button", { name: "Send answers" }));

    expect(onAnswer).toHaveBeenCalledWith(
      "- What should this expose? — A gRPC service\n- Where does the data live? — SQLite file",
    );
  });

  it("fills only the unanswered questions with their recommended option", async () => {
    const onAnswer = vi.fn();
    render(<QuestionCard questions={QUESTIONS} interactive onAnswer={onAnswer} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Postgres/ }));
    await user.click(screen.getByRole("button", { name: "Use recommended" }));
    await user.click(screen.getByRole("button", { name: "Send answers" }));

    expect(onAnswer).toHaveBeenCalledWith(
      "- What should this expose? — HTTP API\n- Where does the data live? — Postgres",
    );
  });

  it("holds the send until every question is answered", async () => {
    const onAnswer = vi.fn();
    render(<QuestionCard questions={QUESTIONS} interactive onAnswer={onAnswer} />);
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /HTTP API/ }));
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    // An opened but empty free-text answer is not an answer.
    await user.click(screen.getAllByRole("button", { name: /Something else/ })[0]);
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
  });

  // An open question asks for a fact only the user has, so there is nothing to
  // click and nothing to recommend — the field is there from the start, and
  // "Use recommended" cannot fill it in.
  it("answers an open question by typing, and never fills it from a recommendation", async () => {
    const onAnswer = vi.fn();
    const questions: AgentQuestion[] = [
      { id: "surface", question: "What should this expose?", options: [{ label: "HTTP API", recommended: true }] },
      { id: "columns", question: "What are the sheet's columns?", options: [] },
    ];
    render(<QuestionCard questions={questions} interactive onAnswer={onAnswer} />);
    const user = userEvent.setup();

    // One per OPTIONED question, and none for the open one — it is already a field.
    expect(screen.getAllByRole("button", { name: /Something else/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Use recommended" }));
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();

    await user.type(
      screen.getByLabelText('Answer to "What are the sheet\'s columns?"'),
      "Date, Hours, Project",
    );
    await user.click(screen.getByRole("button", { name: "Send answers" }));
    expect(onAnswer).toHaveBeenCalledWith(
      "- What should this expose? — HTTP API\n- What are the sheet's columns? — Date, Hours, Project",
    );
  });

  it("offers no way to answer a question the agent has moved past", () => {
    render(<QuestionCard questions={QUESTIONS} interactive={false} onAnswer={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Something else/ })).toBeNull();
    expect(screen.getByRole("button", { name: /HTTP API/ })).toBeDisabled();
  });
});
