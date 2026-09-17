/**
 * Shared types for AgentKey.
 *
 * These mirror the OpenAI "chat completions" wire format so that any
 * OpenAI-compatible endpoint (9router, llama.cpp, vLLM, LiteLLM, Ollama's
 * /v1 shim, OpenAI itself, ...) works without special-casing.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A function call requested by the model. `arguments` is a JSON *string*. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** A message exactly as it goes over the wire. */
export interface WireMessage {
  role: Role;
  content: string | null;
  /** assistant -> tools it wants to run */
  tool_calls?: ToolCall[];
  /** tool -> which call this is the result of */
  tool_call_id?: string;
  /** tool -> name of the tool (some servers require it) */
  name?: string;
}

/** Tool definition sent to the model. */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | null;

/* ------------------------------------------------------------------ */
/* Persistence-level models                                            */
/* ------------------------------------------------------------------ */

export interface ProviderProfile {
  id: string;
  /** Display name, e.g. "9router (home)" */
  name: string;
  /** Base URL *including* the /v1 suffix, e.g. http://192.168.1.10:20128/v1 */
  baseUrl: string;
  /** Model id, e.g. "anthropic/claude-sonnet-4" or "gpt-4o-mini" */
  model: string;
  temperature: number;
  maxTokens: number | null;
  /** Whether an API key is stored in SecureStore for this profile. */
  hasApiKey: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ToolCallStatus =
  | 'pending'      // model asked, we have not decided yet
  | 'awaiting'     // waiting on the user's allow/deny
  | 'running'
  | 'ok'
  | 'error'
  | 'denied';

export interface StoredToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
  status: ToolCallStatus;
  result?: string;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: StoredToolCall[];
  /** Present on tool-result messages. */
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
  /** UI-only: message is still streaming in. */
  streaming?: boolean;
  /** UI-only: request failed. */
  error?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  profileId: string | null;
  createdAt: number;
  updatedAt: number;
}
