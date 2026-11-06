import type { BudgetLimits, BudgetState } from "./types.js";

/** Parse `"$0.04"` shorthand or a full limits object. */
export function parseBudget(input: string | BudgetLimits): BudgetLimits {
  if (typeof input === "string") {
    const m = input.trim().match(/^\$?\s*([0-9]*\.?[0-9]+)$/);
    if (!m) throw new Error(`Invalid budget shorthand: "${input}". Use "$0.04" or a limits object.`);
    return { usd: Number(m[1]), onExhausted: "escalate" };
  }
  if (input.usd === undefined && input.steps === undefined && input.tokens === undefined) {
    throw new Error("Budget needs at least one of usd, steps or tokens.");
  }
  return { onExhausted: "escalate", ...input };
}

/**
 * Hard limits beat smart policies: the loop checks `exceeded()` before any
 * decision policy or model call runs.
 */
export class Budget implements BudgetState {
  usd = 0;
  tokensIn = 0;
  tokensOut = 0;
  steps = 0;

  constructor(public limits: BudgetLimits = {}) {}

  addUsage(tokensIn: number, tokensOut: number, price: { inPerMTok: number; outPerMTok: number }): void {
    this.tokensIn += tokensIn;
    this.tokensOut += tokensOut;
    this.usd += (tokensIn * price.inPerMTok + tokensOut * price.outPerMTok) / 1_000_000;
  }

  addStep(): void {
    this.steps += 1;
  }

  exceeded(): boolean {
    return this.reason() !== "";
  }

  reason(): string {
    const { usd, steps, tokens } = this.limits;
    if (usd !== undefined && this.usd >= usd) return `budget exhausted: $${this.usd.toFixed(4)} >= $${usd}`;
    if (steps !== undefined && this.steps >= steps) return `budget exhausted: ${this.steps} steps >= ${steps}`;
    if (tokens !== undefined && this.tokensIn + this.tokensOut >= tokens)
      return `budget exhausted: ${this.tokensIn + this.tokensOut} tokens >= ${tokens}`;
    return "";
  }
}
