# `.promptEng()`, `.reflect()`, `.debate()`, `.promptTune()`

## `.promptEng(strategies)`

Compose prompting and reasoning strategies. Prompt-level strategies rewrite the messages;
run-level strategies wrap the whole run (sampling, verification, search):

```ts
import { cot, fewShot, stepBack, selfConsistency, cove } from "noble-agent";

bot.promptEng([
  cot({ hidden: true }),                 // reason step-by-step, reply with the answer only
  fewShot([{ user: "Where's my order?", assistant: "Could you share your order id?" }]),
  selfConsistency({ n: 3 }),             // 3 samples, majority vote — needs a budget
]).budget("$0.10");
```

**Expensive strategies refuse to run without a budget.** Anything with `costMultiplier >= 2`
throws at `ready()` unless `.budget()` is set — the error tells you the multiplier. This is
design principle 9 (honest strategies) enforced, including for
[strategies you write yourself](/adapters#strategy).

Full catalogue with costs and when-to-use guidance: [Strategies & costs](/strategies).

| Prompt-level | Run-level |
|---|---|
| `zeroShot` | `selfConsistency({ n })` |
| `role(persona)` | `cove()` — chain-of-verification |
| `fewShot(examples \| (query) => examples)` | `reflect({ rounds, criteria })` |
| `cot({ hidden })` | `reflexion(memory, { rounds })` |
| `stepBack` | `tot({ breadth, depth })` |
| | `skeletonOfThought()` |
| | `chainOfDensity({ rounds })` — summarisation only, validates the task |
| | `programOfThought()` — sandboxed JS, no I/O |
| | `debate({ agents, rounds })` |

### Retrieved few-shot examples

```ts
bot.promptEng([fewShot((query) => exampleStore.nearest(query, 3))]);
```

## `.reflect({ rounds?, criteria? })`

Sugar for appending the `reflect` strategy — a critic loop that reviews the draft answer and
revises it until the critic says it's fine (or `rounds` is spent):

```ts
bot.reflect({ rounds: 1, criteria: "cites a source for every claim" }).budget("$0.10");
```

## `.debate(opts | false)`

Sugar for the `debate` strategy — n independent positions argued, then judged. Expensive
(`agents × rounds + 2`); explicit opt-in with a budget. `.debate(false)` turns it off when a
preset enabled it.

```ts
bot.debate({ agents: 2 }).budget("$0.50");
```

## `.promptTune(opts)`

Records tuning configuration — `keep` lines that must survive verbatim, rounds, holdout
fraction. The actual tuning runs through [`tunePrompt()`](/reference/evaluation#prompt-tuning),
which generates variants from failing eval cases and **refuses any variant that doesn't beat
baseline on a mandatory holdout**.

```ts
bot.promptTune({ rounds: 2, keep: ["Never invent policy details."] });
```
