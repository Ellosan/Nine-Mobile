/**
 * Chat sessions, the live streaming message, and the permission gate that the
 * agent loop blocks on while the user decides whether a tool may run.
 */

import { create } from 'zustand';
import type {
  ChatSession,
  StoredMessage,
  StoredToolCall,
  ToolCall,
  WireMessage,
} from '../types';
import * as db from '../storage/db';
import { uid } from '../util/id';
import { runAgentTurn, type AgentEvent, type PermissionDecision } from '../agent/loop';
import { createToolExecutor } from '../agent/executor';
import { toolsFor } from '../agent/toolSchemas';
import { getApiKeyFor, useSettings, selectActiveProfile } from './settingsStore';
import { fetch as expoFetch } from 'expo/fetch';
import type { FetchLike } from '../api/openai';

/** expo/fetch streams response bodies on native; global fetch does not. */
const fetchImpl = expoFetch as unknown as FetchLike;

export interface PendingPermission {
  call: ToolCall;
  resolve: (decision: PermissionDecision) => void;
}

interface ChatState {
  sessions: ChatSession[];
  sessionsLoaded: boolean;

  activeSessionId: string | null;
  messages: StoredMessage[];
  messagesLoaded: boolean;

  /** True while an agent turn is in flight. */
  busy: boolean;
  /** Short status line shown under the composer, e.g. "running read_file". */
  status: string | null;
  error: string | null;

  pendingPermission: PendingPermission | null;

  loadSessions: () => Promise<void>;
  createSession: (title?: string) => Promise<ChatSession>;
  openSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;

  sendMessage: (text: string) => Promise<void>;
  cancel: () => void;
  resolvePermission: (decision: PermissionDecision) => void;
  clearError: () => void;
}

/** Abort controller for the in-flight turn; kept outside the store. */
let currentAbort: AbortController | null = null;

function newSession(title: string, profileId: string | null): ChatSession {
  const now = Date.now();
  return { id: uid('s_'), title, profileId, createdAt: now, updatedAt: now };
}

/** A title derived from the first thing the user said. */
function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'New chat';
  return oneLine.length <= 40 ? oneLine : `${oneLine.slice(0, 40)}...`;
}

/** Convert stored history into the OpenAI wire format. */
export function toWireMessages(messages: StoredMessage[], systemPrompt: string): WireMessage[] {
  const wire: WireMessage[] = [];
  if (systemPrompt.trim()) wire.push({ role: 'system', content: systemPrompt });

  for (const m of messages) {
    if (m.role === 'user') {
      wire.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      // Skip an assistant turn that failed before producing anything, so a
      // retry does not resend an empty message the server may reject.
      if (!m.content && (!m.toolCalls || m.toolCalls.length === 0)) continue;
      const msg: WireMessage = { role: 'assistant', content: m.content || null };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      wire.push(msg);
      continue;
    }
    if (m.role === 'tool') {
      wire.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        name: m.toolName,
        content: m.content,
      });
    }
  }
  return wire;
}

export const useChat = create<ChatState>((set, get) => ({
  sessions: [],
  sessionsLoaded: false,
  activeSessionId: null,
  messages: [],
  messagesLoaded: false,
  busy: false,
  status: null,
  error: null,
  pendingPermission: null,

  loadSessions: async () => {
    const sessions = await db.listSessions();
    set({ sessions, sessionsLoaded: true });
  },

  createSession: async (title) => {
    const { activeProfileId } = useSettings.getState();
    const session = newSession(title?.trim() || 'New chat', activeProfileId);
    await db.insertSession(session);
    set({ sessions: [session, ...get().sessions] });
    return session;
  },

  openSession: async (id) => {
    set({ activeSessionId: id, messagesLoaded: false, messages: [], error: null });
    const messages = await db.listMessages(id);
    // Guard against a fast session switch landing out of order.
    if (get().activeSessionId !== id) return;
    set({ messages, messagesLoaded: true });
  },

  renameSession: async (id, title) => {
    const clean = title.trim();
    if (!clean) return;
    await db.renameSession(id, clean);
    set({
      sessions: get()
        .sessions.map((s) => (s.id === id ? { ...s, title: clean, updatedAt: Date.now() } : s))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    });
  },

  deleteSession: async (id) => {
    await db.deleteSession(id);
    const sessions = get().sessions.filter((s) => s.id !== id);
    const wasActive = get().activeSessionId === id;
    set({
      sessions,
      activeSessionId: wasActive ? null : get().activeSessionId,
      messages: wasActive ? [] : get().messages,
    });
  },

  cancel: () => {
    currentAbort?.abort();
    // If we were blocked on a permission prompt, unblock it as a denial.
    const pending = get().pendingPermission;
    if (pending) {
      pending.resolve('deny');
      set({ pendingPermission: null });
    }
    set({ status: 'Cancelling...' });
  },

  resolvePermission: (decision) => {
    const pending = get().pendingPermission;
    if (!pending) return;
    set({ pendingPermission: null });
    pending.resolve(decision);
  },

  clearError: () => set({ error: null }),

  sendMessage: async (text) => {
    const content = text.trim();
    if (!content || get().busy) return;

    const settings = useSettings.getState();
    const profile = selectActiveProfile(settings);
    if (!profile) {
      set({ error: 'No provider configured yet. Open Settings and add one.' });
      return;
    }
    if (!profile.baseUrl) {
      set({ error: `Profile "${profile.name}" has no base URL.` });
      return;
    }
    if (!profile.model) {
      set({ error: `Profile "${profile.name}" has no model name.` });
      return;
    }

    // Make sure there is a session to write into.
    let sessionId = get().activeSessionId;
    if (!sessionId) {
      const session = await get().createSession(deriveTitle(content));
      sessionId = session.id;
      set({ activeSessionId: sessionId, messages: [], messagesLoaded: true });
    }

    const apiKey = await getApiKeyFor(profile.id);

    const userMessage: StoredMessage = {
      id: uid('m_'),
      sessionId,
      role: 'user',
      content,
      createdAt: Date.now(),
    };
    await db.saveMessage(userMessage);

    // First real message names an untitled session.
    const session = get().sessions.find((s) => s.id === sessionId);
    if (session && (session.title === 'New chat' || !session.title.trim())) {
      await get().renameSession(sessionId, deriveTitle(content));
    }

    set({
      messages: [...get().messages, userMessage],
      busy: true,
      status: 'Thinking...',
      error: null,
    });

    const abort = new AbortController();
    currentAbort = abort;

    // The assistant message currently being streamed into.
    let liveId: string | null = null;
    let liveCreatedAt = 0;

    const upsertLive = (patch: Partial<StoredMessage>) => {
      set((state) => ({
        messages: state.messages.map((m) => (m.id === liveId ? { ...m, ...patch } : m)),
      }));
    };

    const startLive = () => {
      liveId = uid('m_');
      liveCreatedAt = Date.now();
      const msg: StoredMessage = {
        id: liveId,
        sessionId: sessionId as string,
        role: 'assistant',
        content: '',
        createdAt: liveCreatedAt,
        streaming: true,
      };
      set((state) => ({ messages: [...state.messages, msg] }));
    };

    const onEvent = (event: AgentEvent) => {
      switch (event.type) {
        case 'assistant_start':
          startLive();
          set({ status: 'Thinking...' });
          break;

        case 'text_delta':
          upsertLive({ content: event.text });
          break;

        case 'tool_calls_partial':
          upsertLive({ toolCalls: event.calls.map(toStoredToolCall('pending')) });
          break;

        case 'assistant_done': {
          const toolCalls =
            event.toolCalls.length > 0
              ? event.toolCalls.map(toStoredToolCall('pending'))
              : undefined;
          upsertLive({ content: event.content, toolCalls, streaming: false });
          const finished = get().messages.find((m) => m.id === liveId);
          if (finished) void db.saveMessage({ ...finished, streaming: false });
          break;
        }

        case 'tool_permission_request':
          set({ status: `Waiting for approval: ${event.call.function.name}` });
          patchToolStatus(set, get, liveId, event.call.id, 'awaiting');
          break;

        case 'tool_permission_result':
          if (event.decision === 'deny') {
            patchToolStatus(set, get, liveId, event.call.id, 'denied');
          }
          break;

        case 'tool_start':
          set({ status: `Running ${event.call.function.name}...` });
          patchToolStatus(set, get, liveId, event.call.id, 'running');
          break;

        case 'tool_result': {
          patchToolStatus(
            set,
            get,
            liveId,
            event.call.id,
            event.ok ? 'ok' : 'error',
            event.content
          );
          const owner = get().messages.find((m) => m.id === liveId);
          if (owner) void db.saveMessage(owner);

          const toolMessage: StoredMessage = {
            id: uid('m_'),
            sessionId: sessionId as string,
            role: 'tool',
            content: event.content,
            toolCallId: event.call.id,
            toolName: event.call.function.name,
            createdAt: Date.now(),
          };
          void db.saveMessage(toolMessage);
          set((state) => ({ messages: [...state.messages, toolMessage] }));
          set({ status: 'Thinking...' });
          break;
        }

        case 'error':
          upsertLive({ streaming: false, error: event.error.message });
          set({ error: event.error.message });
          break;

        default:
          break;
      }
    };

    const permissions = {
      request: (call: ToolCall) =>
        new Promise<PermissionDecision>((resolve) => {
          set({ pendingPermission: { call, resolve } });
        }),
    };

    try {
      const history = get().messages.filter((m) => !m.streaming && m.id !== liveId);
      const wire = toWireMessages(history, settings.systemPrompt);

      const tools = toolsFor({
        fileTools: settings.fileToolsEnabled,
        shellTool: settings.shellToolEnabled,
      });

      const result = await runAgentTurn({
        baseUrl: profile.baseUrl,
        apiKey,
        model: profile.model,
        messages: wire,
        tools,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
        maxIterations: settings.maxIterations,
        signal: abort.signal,
        fetchImpl,
        executor: createToolExecutor(),
        permissions,
        onEvent,
      });

      if (result.reason === 'max_iterations') {
        set({
          error: `Stopped after ${result.iterations} tool rounds. Raise the limit in Settings if this was legitimate work.`,
        });
      }

      // Persist whatever the last streamed message ended up as.
      const last = get().messages.find((m) => m.id === liveId);
      if (last) await db.saveMessage({ ...last, streaming: false });
      await db.touchSession(sessionId, profile.id);
      await get().loadSessions();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      if (liveId) upsertLive({ streaming: false, error: message });
    } finally {
      if (currentAbort === abort) currentAbort = null;
      set({ busy: false, status: null, pendingPermission: null });
      // Drop an assistant bubble that never received anything.
      set((state) => ({
        messages: state.messages.filter(
          (m) =>
            !(
              m.id === liveId &&
              m.role === 'assistant' &&
              !m.content &&
              !m.error &&
              (!m.toolCalls || m.toolCalls.length === 0)
            )
        ),
      }));
    }
  },
}));

function toStoredToolCall(status: StoredToolCall['status']) {
  return (c: ToolCall): StoredToolCall => ({
    id: c.id,
    name: c.function.name,
    arguments: c.function.arguments,
    status,
  });
}

function patchToolStatus(
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  messageId: string | null,
  callId: string,
  status: StoredToolCall['status'],
  result?: string
): void {
  if (!messageId) return;
  set((state) => ({
    messages: state.messages.map((m) => {
      if (m.id !== messageId || !m.toolCalls) return m;
      return {
        ...m,
        toolCalls: m.toolCalls.map((tc) =>
          tc.id === callId ? { ...tc, status, result: result ?? tc.result } : tc
        ),
      };
    }),
  }));
  void get;
}
