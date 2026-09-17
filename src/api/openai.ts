/**
 * OpenAI-compatible chat-completions client with SSE streaming.
 *
 * No React Native imports on purpose: the transport (`fetchImpl`) is injected
 * so the exact same code path runs under `expo/fetch` on device and under
 * Node's global fetch in the test suite.
 */

import { createSseParser } from './sse';
import type { FinishReason, ToolCall, ToolSchema, WireMessage } from '../types';

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: any;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: any;
  text(): Promise<string>;
  json?(): Promise<any>;
  body?: any;
}>;

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `HTTP ${status}${body ? `: ${truncate(body, 400)}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}

/** Normalise a user-typed base URL into something we can append paths to. */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw ?? '').trim();
  if (!url) return '';
  // Tolerate a missing scheme -- most 9router setups are plain http on a LAN IP.
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  // Drop trailing slashes.
  url = url.replace(/\/+$/, '');
  return url;
}

/**
 * Join the base URL with an API path, being forgiving about whether the user
 * included the `/v1` suffix or even the full endpoint path.
 */
export function apiUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const clean = path.startsWith('/') ? path : `/${path}`;

  // User pasted the full endpoint already, e.g. ".../v1/chat/completions".
  if (base.toLowerCase().endsWith(clean.toLowerCase())) return base;

  // User included "/v1" (or any versioned suffix) -- don't double it up.
  if (/\/v\d+$/i.test(base)) return `${base}${clean}`;

  return `${base}/v1${clean}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const key = (apiKey ?? '').trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
    // Some OpenAI-compatible routers (9router included) also accept/prefer this.
    headers['x-api-key'] = key;
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* Streaming chat completions                                          */
/* ------------------------------------------------------------------ */

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: WireMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number | null;
  signal?: any;
  fetchImpl: FetchLike;
}

export interface StreamHandlers {
  /** Fired for every content token. */
  onText?: (delta: string, accumulated: string) => void;
  /** Fired whenever the accumulated tool-call list changes. */
  onToolCallDelta?: (calls: ToolCall[]) => void;
  /** Fired once the first byte of the response body arrives. */
  onOpen?: () => void;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  /** Raw `usage` object if the server sent one. */
  usage?: Record<string, unknown>;
  model?: string;
}

interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Accumulates OpenAI streaming `delta` objects into a final assistant turn.
 * Exported for testing -- it is the fiddliest part of the whole client.
 */
export class DeltaAccumulator {
  content = '';
  finishReason: FinishReason = null;
  usage: Record<string, unknown> | undefined;
  model: string | undefined;

  /** Tool calls keyed by their stream `index`. */
  private readonly partials = new Map<number, PartialToolCall>();
  /** Preserves first-seen order, since Map ordering follows insertion anyway. */
  private readonly order: number[] = [];

  /** Returns the text delta (if any) so callers can forward it to the UI. */
  ingest(chunk: any): { textDelta: string; toolCallsChanged: boolean } {
    let textDelta = '';
    let toolCallsChanged = false;

    if (chunk?.model && typeof chunk.model === 'string') this.model = chunk.model;
    if (chunk?.usage && typeof chunk.usage === 'object') this.usage = chunk.usage;

    const choice = chunk?.choices?.[0];
    if (!choice) return { textDelta, toolCallsChanged };

    if (choice.finish_reason) this.finishReason = choice.finish_reason as FinishReason;

    // Non-streaming responses (or servers that echo a full message) put the
    // payload under `message` instead of `delta`.
    const delta = choice.delta ?? choice.message;
    if (!delta) return { textDelta, toolCallsChanged };

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      textDelta = delta.content;
      this.content += delta.content;
    } else if (Array.isArray(delta.content)) {
      // Some gateways send content as an array of parts.
      for (const part of delta.content) {
        const t = typeof part === 'string' ? part : part?.text;
        if (typeof t === 'string' && t.length > 0) {
          textDelta += t;
          this.content += t;
        }
      }
    }

    // Older function_call form -- normalise it onto index 0.
    if (delta.function_call) {
      const p = this.ensure(0);
      if (delta.function_call.name) p.name += delta.function_call.name;
      if (delta.function_call.arguments) p.args += delta.function_call.arguments;
      toolCallsChanged = true;
    }

    if (Array.isArray(delta.tool_calls)) {
      for (let i = 0; i < delta.tool_calls.length; i++) {
        const tc = delta.tool_calls[i];
        // `index` is required by the spec but some servers omit it.
        const index = typeof tc?.index === 'number' ? tc.index : i;
        const p = this.ensure(index);
        if (tc?.id) p.id = tc.id;
        if (tc?.function?.name) p.name += tc.function.name;
        if (typeof tc?.function?.arguments === 'string') p.args += tc.function.arguments;
        toolCallsChanged = true;
      }
    }

    return { textDelta, toolCallsChanged };
  }

  private ensure(index: number): PartialToolCall {
    let p = this.partials.get(index);
    if (!p) {
      p = { id: '', name: '', args: '' };
      this.partials.set(index, p);
      this.order.push(index);
    }
    return p;
  }

  toolCalls(): ToolCall[] {
    const out: ToolCall[] = [];
    for (const index of this.order) {
      const p = this.partials.get(index);
      if (!p) continue;
      if (!p.name && !p.args) continue;
      out.push({
        id: p.id || `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: p.name, arguments: p.args || '{}' },
      });
    }
    return out;
  }

  result(): ChatResult {
    const toolCalls = this.toolCalls();
    return {
      content: this.content,
      toolCalls,
      finishReason: this.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      usage: this.usage,
      model: this.model,
    };
  }
}

/** Reads a WHATWG ReadableStream of bytes as a stream of decoded strings. */
async function* readBody(body: any): AsyncGenerator<string> {
  const decoder = new TextDecoder();

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          yield typeof value === 'string' ? value : decoder.decode(value, { stream: true });
        }
      }
    } finally {
      const flushed = decoder.decode();
      if (flushed) yield flushed;
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // Node streams / anything async-iterable.
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const value of body as AsyncIterable<any>) {
      yield typeof value === 'string' ? value : decoder.decode(value, { stream: true });
    }
    const flushed = decoder.decode();
    if (flushed) yield flushed;
    return;
  }

  throw new Error('Response body is not streamable on this platform');
}

/**
 * POST /chat/completions with `stream: true` and drive the handlers as the
 * response arrives. Resolves with the fully accumulated assistant turn.
 */
export async function streamChatCompletion(
  req: ChatRequest,
  handlers: StreamHandlers = {}
): Promise<ChatResult> {
  const url = apiUrl(req.baseUrl, '/chat/completions');

  const payload: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
  };
  if (typeof req.temperature === 'number') payload.temperature = req.temperature;
  if (req.maxTokens != null) payload.max_tokens = req.maxTokens;
  if (req.tools && req.tools.length > 0) {
    payload.tools = req.tools;
    payload.tool_choice = 'auto';
  }

  const res = await req.fetchImpl(url, {
    method: 'POST',
    headers: { ...authHeaders(req.apiKey), Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal: req.signal,
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new ApiError(res.status, body);
  }

  handlers.onOpen?.();

  const acc = new DeltaAccumulator();
  let sawDone = false;

  const parser = createSseParser((evt) => {
    const data = evt.data;
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    if (!data) return;

    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      // Ignore unparseable frames (keep-alives, partial junk from proxies).
      return;
    }

    // Some gateways deliver errors inline in the stream.
    if (chunk?.error) {
      const msg =
        typeof chunk.error === 'string'
          ? chunk.error
          : chunk.error?.message ?? JSON.stringify(chunk.error);
      throw new ApiError(res.status || 500, JSON.stringify(chunk.error), msg);
    }

    const { textDelta, toolCallsChanged } = acc.ingest(chunk);
    if (textDelta) handlers.onText?.(textDelta, acc.content);
    if (toolCallsChanged) handlers.onToolCallDelta?.(acc.toolCalls());
  });

  // A server that ignores `stream: true` returns a single JSON object; detect
  // that by sniffing the first chunk for a leading '{'.
  let sniffed = false;
  let looksLikeJson = false;
  let rawBuffer = '';

  for await (const text of readBody(res.body)) {
    if (!sniffed) {
      const lead = text.replace(/^﻿/, '').trimStart();
      if (lead.startsWith('{')) looksLikeJson = true;
      sniffed = true;
    }
    if (looksLikeJson) {
      rawBuffer += text;
    } else {
      parser.push(text);
    }
  }

  if (looksLikeJson) {
    try {
      const chunk = JSON.parse(rawBuffer);
      if (chunk?.error) {
        const msg =
          typeof chunk.error === 'string'
            ? chunk.error
            : chunk.error?.message ?? JSON.stringify(chunk.error);
        throw new ApiError(res.status || 500, rawBuffer, msg);
      }
      const { textDelta, toolCallsChanged } = acc.ingest(chunk);
      if (textDelta) handlers.onText?.(textDelta, acc.content);
      if (toolCallsChanged) handlers.onToolCallDelta?.(acc.toolCalls());
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(res.status || 500, truncate(rawBuffer, 800), 'Malformed response from server');
    }
  } else {
    parser.end();
  }

  void sawDone;
  return acc.result();
}

/* ------------------------------------------------------------------ */
/* Non-streaming helpers                                               */
/* ------------------------------------------------------------------ */

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export interface ModelInfo {
  id: string;
  owned_by?: string;
}

/** GET /models -- used by Settings to verify credentials and list models. */
export async function listModels(opts: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: FetchLike;
  signal?: any;
}): Promise<ModelInfo[]> {
  const res = await opts.fetchImpl(apiUrl(opts.baseUrl, '/models'), {
    method: 'GET',
    headers: authHeaders(opts.apiKey),
    signal: opts.signal,
  });
  const text = await safeText(res);
  if (!res.ok) throw new ApiError(res.status, text);

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(res.status, truncate(text, 400), 'Server did not return JSON');
  }

  const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
  return list
    .map((m: any) => ({
      id: typeof m === 'string' ? m : String(m?.id ?? ''),
      owned_by: typeof m?.owned_by === 'string' ? m.owned_by : undefined,
    }))
    .filter((m: ModelInfo) => m.id.length > 0);
}
