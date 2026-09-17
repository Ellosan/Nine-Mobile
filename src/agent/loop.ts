/**
 * The agentic loop.
 *
 * stream -> if the model asked for tools, gate them behind a user decision,
 * execute, feed the results back -> stream again, until the model stops asking
 * for tools (or we hit the iteration cap).
 *
 * Intentionally free of React Native imports: the model transport, the tool
 * executor and the permission gate are all injected, so the whole loop runs
 * headlessly in tests.
 */

import { streamChatCompletion, ApiError } from '../api/openai';
import type { ChatResult, FetchLike } from '../api/openai';
import { isDestructive } from './toolSchemas';
import type { ToolCall, ToolSchema, WireMessage } from '../types';

export type PermissionDecision = 'allow' | 'allow_session' | 'deny';

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model as the tool message content. */
  content: string;
}

export interface ToolExecutor {
  /** Run a tool. Should not throw: report failures as { ok: false }. */
  execute(call: ToolCall, signal?: any): Promise<ToolResult>;
}

export interface PermissionGate {
  /** Ask the user. Resolve with their decision. */
  request(call: ToolCall): Promise<PermissionDecision>;
}

export type AgentEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'assistant_start'; iteration: number }
  | { type: 'text_delta'; delta: string; text: string }
  | { type: 'tool_calls_partial'; calls: ToolCall[] }
  | { type: 'assistant_done'; content: string; toolCalls: ToolCall[] }
  | { type: 'tool_permission_request'; call: ToolCall }
  | { type: 'tool_permission_result'; call: ToolCall; decision: PermissionDecision }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall; ok: boolean; content: string }
  | { type: 'turn_complete'; reason: 'stop' | 'max_iterations' | 'aborted' }
  | { type: 'error'; error: Error };

export interface RunAgentOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Full conversation so far, in wire format. Not mutated. */
  messages: WireMessage[];
  tools: ToolSchema[];
  temperature?: number;
  maxTokens?: number | null;
  /** Safety valve against a model that loops on tools forever. */
  maxIterations?: number;
  signal?: any;
  fetchImpl: FetchLike;
  executor: ToolExecutor;
  permissions: PermissionGate;
  onEvent: (event: AgentEvent) => void;
}

export interface RunAgentResult {
  /** Every message produced during this turn (assistant + tool messages). */
  newMessages: WireMessage[];
  iterations: number;
  reason: 'stop' | 'max_iterations' | 'aborted' | 'error';
  error?: Error;
}

function isAbort(err: unknown): boolean {
  const e = err as any;
  return (
    e?.name === 'AbortError' ||
    e?.name === 'CanceledError' ||
    /abort/i.test(String(e?.message ?? ''))
  );
}

/** Formats an executor/permission failure as something useful to the model. */
function errorResult(message: string): ToolResult {
  return { ok: false, content: `ERROR: ${message}` };
}

export async function runAgentTurn(opts: RunAgentOptions): Promise<RunAgentResult> {
  const maxIterations = opts.maxIterations ?? 12;
  const conversation: WireMessage[] = [...opts.messages];
  const newMessages: WireMessage[] = [];

  // Tools the user approved for the rest of this turn via "allow for session".
  const sessionApproved = new Set<string>();

  let iteration = 0;

  try {
    for (; iteration < maxIterations; iteration++) {
      if (opts.signal?.aborted) {
        opts.onEvent({ type: 'turn_complete', reason: 'aborted' });
        return { newMessages, iterations: iteration, reason: 'aborted' };
      }

      opts.onEvent({ type: 'iteration_start', iteration });
      opts.onEvent({ type: 'assistant_start', iteration });

      let result: ChatResult;
      try {
        result = await streamChatCompletion(
          {
            baseUrl: opts.baseUrl,
            apiKey: opts.apiKey,
            model: opts.model,
            messages: conversation,
            tools: opts.tools.length > 0 ? opts.tools : undefined,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            signal: opts.signal,
            fetchImpl: opts.fetchImpl,
          },
          {
            onText: (delta, text) => opts.onEvent({ type: 'text_delta', delta, text }),
            onToolCallDelta: (calls) => opts.onEvent({ type: 'tool_calls_partial', calls }),
          }
        );
      } catch (err) {
        if (isAbort(err) || opts.signal?.aborted) {
          opts.onEvent({ type: 'turn_complete', reason: 'aborted' });
          return { newMessages, iterations: iteration, reason: 'aborted' };
        }
        const error = err instanceof Error ? err : new Error(String(err));
        opts.onEvent({ type: 'error', error });
        return { newMessages, iterations: iteration, reason: 'error', error };
      }

      opts.onEvent({
        type: 'assistant_done',
        content: result.content,
        toolCalls: result.toolCalls,
      });

      const assistantMessage: WireMessage = {
        role: 'assistant',
        content: result.content.length > 0 ? result.content : null,
      };
      if (result.toolCalls.length > 0) assistantMessage.tool_calls = result.toolCalls;

      conversation.push(assistantMessage);
      newMessages.push(assistantMessage);

      // No tools requested -> the turn is finished.
      if (result.toolCalls.length === 0) {
        opts.onEvent({ type: 'turn_complete', reason: 'stop' });
        return { newMessages, iterations: iteration + 1, reason: 'stop' };
      }

      // Run each requested tool in order, gating the dangerous ones.
      for (const call of result.toolCalls) {
        if (opts.signal?.aborted) {
          opts.onEvent({ type: 'turn_complete', reason: 'aborted' });
          return { newMessages, iterations: iteration + 1, reason: 'aborted' };
        }

        const name = call.function.name;
        let toolResult: ToolResult;

        const needsApproval = isDestructive(name) && !sessionApproved.has(name);

        if (needsApproval) {
          opts.onEvent({ type: 'tool_permission_request', call });
          let decision: PermissionDecision;
          try {
            decision = await opts.permissions.request(call);
          } catch (err) {
            decision = isAbort(err) ? 'deny' : 'deny';
          }
          opts.onEvent({ type: 'tool_permission_result', call, decision });

          if (decision === 'allow_session') sessionApproved.add(name);

          if (decision === 'deny') {
            toolResult = {
              ok: false,
              content:
                `DENIED: the user declined to run ${name}. Do not retry this call. ` +
                `Explain what you wanted to do and ask how they would like to proceed.`,
            };
            opts.onEvent({ type: 'tool_result', call, ok: false, content: toolResult.content });
            pushToolMessage(conversation, newMessages, call, toolResult.content);
            continue;
          }
        }

        opts.onEvent({ type: 'tool_start', call });
        try {
          toolResult = await opts.executor.execute(call, opts.signal);
        } catch (err) {
          if (isAbort(err) || opts.signal?.aborted) {
            opts.onEvent({ type: 'turn_complete', reason: 'aborted' });
            return { newMessages, iterations: iteration + 1, reason: 'aborted' };
          }
          toolResult = errorResult(err instanceof Error ? err.message : String(err));
        }

        opts.onEvent({
          type: 'tool_result',
          call,
          ok: toolResult.ok,
          content: toolResult.content,
        });
        pushToolMessage(conversation, newMessages, call, toolResult.content);
      }
      // Loop again so the model can react to the tool results.
    }

    opts.onEvent({ type: 'turn_complete', reason: 'max_iterations' });
    return { newMessages, iterations: iteration, reason: 'max_iterations' };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    opts.onEvent({ type: 'error', error });
    return { newMessages, iterations: iteration, reason: 'error', error };
  }
}

function pushToolMessage(
  conversation: WireMessage[],
  newMessages: WireMessage[],
  call: ToolCall,
  content: string
): void {
  const msg: WireMessage = {
    role: 'tool',
    tool_call_id: call.id,
    name: call.function.name,
    content,
  };
  conversation.push(msg);
  newMessages.push(msg);
}

export { ApiError };
