# evals

Generated eval artifacts land here (promptfoo configs, pick-model reports, tune diffs).

Flow:

1. Configure the dataset on the bot: `.evaluate({ dataset, assert: ["cites-source", "escalates-correctly", "cost", "faithfulness"] })` — see `examples/support-bot/src/full-api.ts`.
2. `noble eval --bot ./src/bot.ts` writes `promptfooconfig.yaml`; run it with `npx promptfoo eval`. Results link back to run traces via `traceId`.
3. `noble pick-model` scores `.model("auto", { candidates })` on the dataset and writes `noble.lock`, which the runtime honours.
4. `tunePrompt()` / `noble accept` iterate the system prompt with a mandatory holdout — variants that don't beat baseline are refused.
