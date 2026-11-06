import Anthropic from "@anthropic-ai/sdk";
import type { Message, ModelAdapter, ModelChunk, ModelRequest, ModelResponse, ToolCall } from "@noble-agent/core";
import { priceFor } from "./models.js";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** Map noble messages to Anthropic's user/assistant + content-block shape. */
export function toAnthropicMessages(messages: Message[]): { system: string[]; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system.push(m.content);
    } else if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      out.push({ role: "assistant", content: blocks.length ? blocks : m.content });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }],
      });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  // Anthropic requires alternating roles starting with user; merge consecutive same-role turns.
  const merged: AnthropicMessage[] = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      const a = typeof prev.content === "string" ? [{ type: "text", text: prev.content } as AnthropicContentBlock] : prev.content;
      const b = typeof m.content === "string" ? [{ type: "text", text: m.content } as AnthropicContentBlock] : m.content;
      prev.content = [...a, ...b];
    } else {
      merged.push({ ...m });
    }
  }
  return { system, messages: merged };
}

export class AnthropicAdapter implements ModelAdapter {
  private client: Anthropic;
  price: { inPerMTok: number; outPerMTok: number };

  constructor(
    public id: string,
    opts: { apiKey?: string } = {}
  ) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.price = priceFor(id);
  }

  private buildParams(req: ModelRequest) {
    const { system, messages } = toAnthropicMessages(req.messages);
    const sys = [req.system, ...system].filter(Boolean).join("\n\n");
    return {
      model: req.model ?? this.id,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature,
      system: sys || undefined,
      messages: messages as Anthropic.MessageParam[],
      tools: req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    };
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const res = await this.client.messages.create(this.buildParams(req));
    const toolCalls: ToolCall[] = [];
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
    return {
      text,
      toolCalls,
      usage: { tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens },
      stopReason: res.stop_reason === "tool_use" ? "tool_use" : res.stop_reason === "max_tokens" ? "max_tokens" : "end",
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
    const stream = this.client.messages.stream(this.buildParams(req));
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "token", text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const toolCalls: ToolCall[] = final.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));
    if (toolCalls.length) yield { type: "toolCalls", toolCalls };
    yield { type: "usage", usage: { tokensIn: final.usage.input_tokens, tokensOut: final.usage.output_tokens } };
  }
}
