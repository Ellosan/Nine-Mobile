/**
 * Provider profiles and app-wide agent settings.
 *
 * API keys are deliberately NOT part of this store: they live in SecureStore
 * and are fetched on demand right before a request is sent, so a key can never
 * leak through a React devtools snapshot or a persisted store dump.
 */

import { create } from 'zustand';
import type { ProviderProfile } from '../types';
import { DEFAULT_SYSTEM_PROMPT } from '../agent/toolSchemas';
import {
  deleteProfile as dbDeleteProfile,
  getSetting,
  listProfiles,
  setSetting,
  upsertProfile,
} from '../storage/db';
import { deleteApiKey, loadApiKey, saveApiKey } from '../storage/secure';
import { getWorkspaceRoot, setWorkspaceRoot as persistWorkspaceRoot } from '../storage/workspace';
import { uid } from '../util/id';

const SETTING_ACTIVE_PROFILE = 'settings.activeProfileId';
const SETTING_FILE_TOOLS = 'settings.fileToolsEnabled';
const SETTING_SHELL_TOOL = 'settings.shellToolEnabled';
const SETTING_SYSTEM_PROMPT = 'settings.systemPrompt';
const SETTING_MAX_ITERATIONS = 'settings.maxIterations';

export interface ProfileInput {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number | null;
}

interface SettingsState {
  loaded: boolean;
  profiles: ProviderProfile[];
  activeProfileId: string | null;

  workspaceRoot: string | null;
  fileToolsEnabled: boolean;
  shellToolEnabled: boolean;
  systemPrompt: string;
  maxIterations: number;

  hydrate: () => Promise<void>;
  createProfile: (input: ProfileInput) => Promise<ProviderProfile>;
  updateProfile: (id: string, input: Partial<ProfileInput>) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  setActiveProfile: (id: string | null) => Promise<void>;

  setWorkspaceRoot: (uri: string | null) => Promise<void>;
  setFileToolsEnabled: (on: boolean) => Promise<void>;
  setShellToolEnabled: (on: boolean) => Promise<void>;
  setSystemPrompt: (prompt: string) => Promise<void>;
  setMaxIterations: (n: number) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  profiles: [],
  activeProfileId: null,
  workspaceRoot: null,
  fileToolsEnabled: true,
  shellToolEnabled: false,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxIterations: 12,

  hydrate: async () => {
    const [profiles, activeId, fileTools, shellTool, prompt, maxIter, root] = await Promise.all([
      listProfiles(),
      getSetting(SETTING_ACTIVE_PROFILE),
      getSetting(SETTING_FILE_TOOLS),
      getSetting(SETTING_SHELL_TOOL),
      getSetting(SETTING_SYSTEM_PROMPT),
      getSetting(SETTING_MAX_ITERATIONS),
      getWorkspaceRoot(),
    ]);

    // If the remembered profile was deleted, fall back to the first one.
    const resolvedActive =
      activeId && profiles.some((p) => p.id === activeId)
        ? activeId
        : (profiles[0]?.id ?? null);

    const parsedMax = maxIter ? Number.parseInt(maxIter, 10) : NaN;

    set({
      loaded: true,
      profiles,
      activeProfileId: resolvedActive,
      workspaceRoot: root,
      fileToolsEnabled: fileTools === null ? true : fileTools === '1',
      shellToolEnabled: shellTool === '1',
      systemPrompt: prompt ?? DEFAULT_SYSTEM_PROMPT,
      maxIterations: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 12,
    });
  },

  createProfile: async (input) => {
    const now = Date.now();
    const profile: ProviderProfile = {
      id: uid('p_'),
      name: input.name.trim() || 'Untitled provider',
      baseUrl: input.baseUrl.trim(),
      model: input.model.trim(),
      temperature: input.temperature ?? 0.7,
      maxTokens: input.maxTokens ?? null,
      hasApiKey: Boolean(input.apiKey && input.apiKey.trim()),
      createdAt: now,
      updatedAt: now,
    };

    if (input.apiKey && input.apiKey.trim()) {
      await saveApiKey(profile.id, input.apiKey);
    }
    await upsertProfile(profile);

    const profiles = [...get().profiles, profile];
    const activeProfileId = get().activeProfileId ?? profile.id;
    set({ profiles, activeProfileId });
    if (get().activeProfileId === profile.id) {
      await setSetting(SETTING_ACTIVE_PROFILE, profile.id);
    }
    return profile;
  },

  updateProfile: async (id, input) => {
    const existing = get().profiles.find((p) => p.id === id);
    if (!existing) return;

    // An empty string means "leave the stored key alone"; only a non-empty
    // value replaces it, and an explicit null clears it.
    let hasApiKey = existing.hasApiKey;
    if (input.apiKey !== undefined) {
      const trimmed = (input.apiKey ?? '').trim();
      if (trimmed) {
        await saveApiKey(id, trimmed);
        hasApiKey = true;
      }
    }

    const updated: ProviderProfile = {
      ...existing,
      name: input.name?.trim() || existing.name,
      baseUrl: input.baseUrl?.trim() ?? existing.baseUrl,
      model: input.model?.trim() ?? existing.model,
      temperature: input.temperature ?? existing.temperature,
      maxTokens: input.maxTokens === undefined ? existing.maxTokens : input.maxTokens,
      hasApiKey,
      updatedAt: Date.now(),
    };

    await upsertProfile(updated);
    set({ profiles: get().profiles.map((p) => (p.id === id ? updated : p)) });
  },

  removeProfile: async (id) => {
    await deleteApiKey(id);
    await dbDeleteProfile(id);
    const profiles = get().profiles.filter((p) => p.id !== id);
    let activeProfileId = get().activeProfileId;
    if (activeProfileId === id) {
      activeProfileId = profiles[0]?.id ?? null;
      if (activeProfileId) await setSetting(SETTING_ACTIVE_PROFILE, activeProfileId);
    }
    set({ profiles, activeProfileId });
  },

  setActiveProfile: async (id) => {
    set({ activeProfileId: id });
    if (id) await setSetting(SETTING_ACTIVE_PROFILE, id);
  },

  setWorkspaceRoot: async (uri) => {
    await persistWorkspaceRoot(uri);
    set({ workspaceRoot: uri });
  },

  setFileToolsEnabled: async (on) => {
    await setSetting(SETTING_FILE_TOOLS, on ? '1' : '0');
    set({ fileToolsEnabled: on });
  },

  setShellToolEnabled: async (on) => {
    await setSetting(SETTING_SHELL_TOOL, on ? '1' : '0');
    set({ shellToolEnabled: on });
  },

  setSystemPrompt: async (prompt) => {
    await setSetting(SETTING_SYSTEM_PROMPT, prompt);
    set({ systemPrompt: prompt });
  },

  setMaxIterations: async (n) => {
    const clamped = Math.max(1, Math.min(50, Math.floor(n)));
    await setSetting(SETTING_MAX_ITERATIONS, String(clamped));
    set({ maxIterations: clamped });
  },
}));

/** The currently selected profile, or null. */
export function selectActiveProfile(state: SettingsState): ProviderProfile | null {
  if (!state.activeProfileId) return null;
  return state.profiles.find((p) => p.id === state.activeProfileId) ?? null;
}

/** Fetch the API key for a profile straight from SecureStore. */
export async function getApiKeyFor(profileId: string): Promise<string> {
  return loadApiKey(profileId);
}
