/**
 * API keys live in expo-secure-store (Android Keystore-backed), never in
 * SQLite, AsyncStorage or the Zustand snapshot that renders the UI.
 */

import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'agentkey_apikey_';

/** SecureStore keys must be alphanumeric plus ".", "-", "_". */
function storeKey(profileId: string): string {
  const safe = profileId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${KEY_PREFIX}${safe}`;
}

export async function saveApiKey(profileId: string, apiKey: string): Promise<void> {
  const value = (apiKey ?? '').trim();
  if (!value) {
    await deleteApiKey(profileId);
    return;
  }
  await SecureStore.setItemAsync(storeKey(profileId), value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

export async function loadApiKey(profileId: string): Promise<string> {
  try {
    const v = await SecureStore.getItemAsync(storeKey(profileId));
    return v ?? '';
  } catch {
    // A corrupted / unreadable entry should not brick the app.
    return '';
  }
}

export async function deleteApiKey(profileId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(storeKey(profileId));
  } catch {
    /* already gone */
  }
}

export async function isSecureStoreAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

/** Never render a raw key. */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(12, key.length - 8))}${key.slice(-4)}`;
}
