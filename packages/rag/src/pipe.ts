import { makeEvent } from "@noble-agent/core";
import type { RagState, RagStep } from "./types.js";

/** Compose steps left to right; each step emits a rag.step event. */
export function pipe(...steps: [string, RagStep][]): RagStep {
  return async (state: RagState) => {
    let s = state;
    for (const [name, step] of steps) {
      if (s.skip) break;
      s = await step(s);
      s.ctx.emit(
        makeEvent("rag.step", s.ctx.traceId, {
          step: name,
          chunks: s.chunks.length,
          query: s.query.slice(0, 120),
        })
      );
    }
    return s;
  };
}

/** Conditional branch: run `yes` when pred holds, otherwise `no` (or nothing). */
export function branch(pred: (s: RagState) => boolean, yes: RagStep, no?: RagStep): RagStep {
  return async (state: RagState) => (pred(state) ? yes(state) : no ? no(state) : state);
}
