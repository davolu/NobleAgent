import type { ModelAdapter, ModelChunk, ModelRequest, ModelResponse, ToolCall } from "@noble-agent/core";

export interface MockTurn {
  text?: string;
  toolCalls?: (Omit<ToolCall, "id"> & { id?: string })[];
  usage?: { tokensIn: number; tokensOut: number };
}

export type MockScript = (MockTurn | ((req: ModelRequest) => MockTurn))[] | ((req: ModelRequest) => MockTurn);

/**
 * Scripted model for tests and recorded fixtures. Each `complete()` consumes
 * the next turn; when the script is exhausted the adapter repeats the last
 * turn if `loop` is set (to exercise maxSteps/budget stops) or returns a
 * final plain answer.
 */
export class MockModelAdapter implements ModelAdapter {
  requests: ModelRequest[] = [];
  price: { inPerMTok: number; outPerMTok: number };
  private i = 0;
  private counter = 0;

  constructor(
    private script: MockScript,
    private opts: { id?: string; price?: { inPerMTok: number; outPerMTok: number }; loop?: boolean } = {}
  ) {
    this.price = opts.price ?? { inPerMTok: 3, outPerMTok: 15 };
  }

  get id(): string {
    return this.opts.id ?? "mock-model";
  }

  private next(req: ModelRequest): MockTurn {
    if (typeof this.script === "function") return this.script(req);
    let turn = this.script[this.i];
    if (turn === undefined) {
      if (this.opts.loop && this.script.length) turn = this.script[this.script.length - 1];
      else return { text: "done" };
    } else {
      this.i++;
    }
    return typeof turn === "function" ? turn(req) : turn;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone({ ...req, tools: req.tools })); // record for assertions
    const turn = this.next(req);
    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((tc) => ({
      id: tc.id ?? `call_${++this.counter}`,
      name: tc.name,
      args: tc.args,
    }));
    return {
      text: turn.text ?? "",
      toolCalls,
      usage: turn.usage ?? { tokensIn: 100, tokensOut: 50 },
      stopReason: toolCalls.length ? "tool_use" : "end",
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
    const res = await this.complete(req);
    for (const word of res.text ? res.text.split(/(?<= )/) : []) {
      yield { type: "token", text: word };
    }
    if (res.toolCalls.length) yield { type: "toolCalls", toolCalls: res.toolCalls };
    yield { type: "usage", usage: res.usage };
  }
}
