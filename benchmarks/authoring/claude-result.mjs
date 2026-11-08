// Reads Claude Code's `--output-format stream-json` output. The final `result` event carries the
// token counts, cost and turns; tool calls are counted from the `tool_use` blocks of the
// `assistant` events, because the result event does not carry them.

function parseLines(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      throw new Error(`the agent's output holds a line that is not JSON: ${trimmed.slice(0, 200)}`);
    }
  }
  return events;
}

const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function tokensOf(usage) {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
  };
}

// Returns { complete, isError, subject, tokens, costUsd, turns, toolCalls }. Without a result
// event (the attempt was killed) the tokens are summed from the assistant events, one usage per
// message, and the cost is unknown (null).
export function parseAgentOutput(text) {
  const events = parseLines(text);
  const toolUses = new Set();
  const usageByMessage = new Map();
  let turns = 0;
  let result;
  for (const event of events) {
    if (event.type === "assistant" && event.message) {
      turns++;
      for (const block of event.message.content ?? []) if (block.type === "tool_use") toolUses.add(block.id);
      if (event.message.id && event.message.usage) usageByMessage.set(event.message.id, event.message.usage);
    } else if (event.type === "result") result = event;
  }
  if (result) {
    return {
      complete: true,
      isError: result.is_error === true,
      subtype: result.subtype ?? null,
      tokens: tokensOf(result.usage),
      costUsd: result.total_cost_usd ?? 0,
      turns: result.num_turns ?? turns,
      toolCalls: toolUses.size,
    };
  }
  const tokens = zeroTokens();
  for (const usage of usageByMessage.values()) {
    const t = tokensOf(usage);
    for (const key of Object.keys(tokens)) tokens[key] += t[key];
  }
  return { complete: false, isError: true, subtype: null, tokens, costUsd: null, turns, toolCalls: toolUses.size };
}
