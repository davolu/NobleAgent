import OpenAI from "openai";
import type { Message, ModelAdapter, ModelChunk, ModelRequest, ModelResponse, ToolCall } from "@noble-agent/core";
import { priceFor } from "./models.js";

export function toOpenAIMessages(req: ModelRequest): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages as Message[]) {
    if (m.role === "system") out.push({ role: "system", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls?.length
          ? m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
            }))
          : undefined,
      });
    } else if (m.role === "tool") {
      out.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

export class OpenAIAdapter implements ModelAdapter {
  private client: OpenAI;
  price: { inPerMTok: number; outPerMTok: number };

  constructor(
    public id: string,
    opts: { apiKey?: string } = {}
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY });
    this.price = priceFor(id);
  }

  private buildParams(req: ModelRequest): OpenAI.ChatCompletionCreateParams {
    return {
      model: req.model ?? this.id,
      messages: toOpenAIMessages(req),
      max_completion_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature,
      tools: req.tools?.length
        ? req.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          }))
        : undefined,
    };
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const res = (await this.client.chat.completions.create({
      ...this.buildParams(req),
      stream: false,
    })) as OpenAI.ChatCompletion;
    const choice = res.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? [])
      .filter((tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: "function" } => tc.type === "function")
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: safeParse(tc.function.arguments),
      }));
    return {
      text: choice.message.content ?? "",
      toolCalls,
      usage: { tokensIn: res.usage?.prompt_tokens ?? 0, tokensOut: res.usage?.completion_tokens ?? 0 },
      stopReason: choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end",
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
    const stream = await this.client.chat.completions.create({
      ...this.buildParams(req),
      stream: true,
      stream_options: { include_usage: true },
    });
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) yield { type: "token", text: delta.content };
      for (const tc of delta?.tool_calls ?? []) {
        const acc = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAcc.set(tc.index, acc);
      }
      if (chunk.usage) {
        yield { type: "usage", usage: { tokensIn: chunk.usage.prompt_tokens, tokensOut: chunk.usage.completion_tokens } };
      }
    }
    if (toolAcc.size) {
      yield {
        type: "toolCalls",
        toolCalls: [...toolAcc.values()].map((a) => ({ id: a.id, name: a.name, args: safeParse(a.args) })),
      };
    }
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return { _raw: s };
  }
}
