export { zeroShot, role, fewShot, cot, stepBack, type FewShotExample } from "./prompt.js";
export {
  selfConsistency,
  cove,
  tot,
  skeletonOfThought,
  chainOfDensity,
  programOfThought,
  reflect,
  reflexion,
  debate,
} from "./run.js";

import type { Strategy } from "@noble-agent/core";
import { reflect, debate } from "./run.js";

/** Registry hook: lets core's .reflect()/.debate() resolve to strategies. */
export function strategyFactory(name: string, opts: Record<string, unknown> = {}): Strategy {
  switch (name) {
    case "reflect":
      return reflect(opts);
    case "debate":
      return debate(opts);
    default:
      throw new Error(`Unknown strategy "${name}".`);
  }
}
