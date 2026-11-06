#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { acceptTune, generatePromptfooConfig, type NobleAgent } from "noble-agent";

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

/** Load the user's bot module: `--bot ./bot.ts` or ./noble.config.{ts,js,mjs}. */
async function loadBot(): Promise<NobleAgent> {
  const candidates = [flag("bot"), "./noble.config.ts", "./noble.config.js", "./noble.config.mjs", "./bot.ts", "./bot.js"].filter(
    Boolean
  ) as string[];
  for (const c of candidates) {
    try {
      const mod = await import(pathToFileURL(resolve(c)).href);
      const bot = mod.bot ?? mod.default;
      if (bot && typeof bot.ask === "function") return bot as NobleAgent;
    } catch (err: any) {
      if (err?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
        throw new Error(
          `This Node version cannot import "${c}" directly. Run the CLI through tsx (npx tsx $(which noble) …), use a newer Node with type stripping, or point --bot at compiled JS.`
        );
      }
      if (err?.code !== "ERR_MODULE_NOT_FOUND" && !/Cannot find module/.test(String(err))) throw err;
    }
  }
  throw new Error("No bot module found. Pass --bot ./bot.ts (exporting `bot`) or create noble.config.ts.");
}

const HELP = `noble <command>

  explain      print every resolved setting and its source
  eval         generate promptfooconfig.yaml from the bot's .evaluate() config
  eval-run     run one input through the bot, print the RunResult JSON (used by promptfoo)
  reindex      re-ingest the .docs() corpus
  pick-model   score candidate models on the eval dataset and write noble.lock
  tune         tune the system prompt against failing eval cases (writes a diff)
  accept       apply a tune diff: noble accept --diff noble-prompt.diff --prompt ./prompt.txt

Common flags: --bot ./bot.ts`;

try {
  switch (cmd) {
    case "explain": {
      const bot = await loadBot();
      await bot.ready().catch(() => undefined); // explain works even half-configured
      console.log(bot.explain());
      break;
    }
    case "eval": {
      const bot = await loadBot();
      const cfg = bot.getConfig().get("evaluate")?.value as any;
      if (!cfg) throw new Error("The bot has no .evaluate() config.");
      const yaml = generatePromptfooConfig(cfg, { outPath: "promptfooconfig.yaml", botModule: flag("bot") ?? "./bot.ts" });
      console.log("Wrote promptfooconfig.yaml. Run: npx promptfoo eval");
      void yaml;
      break;
    }
    case "eval-run": {
      const bot = await loadBot();
      const input = flag("input") ?? (await readStdin());
      const r = await bot.ask(input, { sessionId: `eval-${Date.now()}` });
      console.log(JSON.stringify(r));
      break;
    }
    case "reindex": {
      const bot = await loadBot();
      await bot.reindex();
      console.log("Reindexed.");
      break;
    }
    case "pick-model": {
      const bot = await loadBot();
      const cfg = bot.getConfig().get("evaluate")?.value as any;
      const modelOpts = bot.getConfig().get("modelOpts")?.value as any;
      const candidates: string[] = modelOpts?.candidates ?? [];
      if (!cfg?.dataset || !candidates.length)
        throw new Error("pick-model needs .evaluate({ dataset }) and .model('auto', { candidates: [...] }).");
      const { pickModel } = await import("noble-agent");
      const report = await pickModel({
        candidates: candidates.map((model) => ({ model })),
        dataset: cfg.dataset,
        minQuality: modelOpts?.minQuality,
        runCase: async (model, input) => {
          const { createAdapter } = await import("noble-agent");
          const t0 = Date.now();
          const probe = bot; // same config, overridden model
          probe.model(createAdapter(model));
          const result = await probe.ask(input, { sessionId: `pick-${model}` });
          return { result, latencyMs: Date.now() - t0 };
        },
      });
      console.log(`noble.lock written — winner: ${report.winner}`);
      break;
    }
    case "tune": {
      console.log(
        "Prompt tuning runs through the library: see tunePrompt() in noble-agent and docs/eval.md. It writes noble-prompt.diff; apply with `noble accept`."
      );
      break;
    }
    case "accept": {
      const diff = flag("diff") ?? "noble-prompt.diff";
      const prompt = flag("prompt");
      if (!prompt) throw new Error("accept needs --prompt <file containing the base prompt>.");
      acceptTune(diff, prompt);
      console.log(`Applied ${diff} to ${prompt}.`);
      break;
    }
    default:
      console.log(HELP);
      process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error(`noble ${cmd}: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8").trim();
}
