/**
 * Add or edit a provider profile.
 *
 * "Test connection" hits GET /models with exactly the credentials entered, so a
 * bad base URL or key is caught here rather than mid-chat.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetch as expoFetch } from 'expo/fetch';
import { useSettings } from '../../../src/state/settingsStore';
import { getApiKeyFor } from '../../../src/state/settingsStore';
import { listModels, normalizeBaseUrl, type FetchLike } from '../../../src/api/openai';
import { maskApiKey } from '../../../src/storage/secure';
import { Banner, Button, Field } from '../../../src/ui/components';
import { colors, radius, spacing } from '../../../src/ui/theme';

const fetchImpl = expoFetch as unknown as FetchLike;

export default function ProfileScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : 'new';
  const isNew = id === 'new';
  const insets = useSafeAreaInsets();

  const profiles = useSettings((s) => s.profiles);
  const createProfile = useSettings((s) => s.createProfile);
  const updateProfile = useSettings((s) => s.updateProfile);
  const removeProfile = useSettings((s) => s.removeProfile);
  const setActiveProfile = useSettings((s) => s.setActiveProfile);

  const existing = useMemo(() => profiles.find((p) => p.id === id) ?? null, [profiles, id]);

  const [name, setName] = useState(existing?.name ?? '9router');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? 'http://192.168.1.10:20128/v1');
  const [model, setModel] = useState(existing?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [temperature, setTemperature] = useState(String(existing?.temperature ?? 0.7));
  const [maxTokens, setMaxTokens] = useState(
    existing?.maxTokens != null ? String(existing.maxTokens) : ''
  );

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ tone: 'info' | 'danger'; text: string } | null>(
    null
  );
  const [models, setModels] = useState<string[]>([]);
  const [storedKeyMask, setStoredKeyMask] = useState('');

  useEffect(() => {
    if (!existing?.hasApiKey) return;
    void getApiKeyFor(existing.id).then((k) => setStoredKeyMask(maskApiKey(k)));
  }, [existing]);

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Prefer the key just typed; otherwise fall back to the stored one.
      const key = apiKey.trim() || (existing ? await getApiKeyFor(existing.id) : '');
      const found = await listModels({ baseUrl, apiKey: key, fetchImpl });
      setModels(found.map((m) => m.id));
      setTestResult({
        tone: 'info',
        text: `Connected. ${found.length} model${found.length === 1 ? '' : 's'} available.`,
      });
      if (!model && found[0]) setModel(found[0].id);
    } catch (err) {
      setTestResult({
        tone: 'danger',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    if (!baseUrl.trim()) {
      Alert.alert('Base URL required', 'Enter the OpenAI-compatible endpoint, e.g. http://host:20128/v1');
      return;
    }
    if (!model.trim()) {
      Alert.alert('Model required', 'Enter the model name your endpoint expects.');
      return;
    }

    const temp = Number.parseFloat(temperature);
    const maxTok = maxTokens.trim() ? Number.parseInt(maxTokens, 10) : null;

    const input = {
      name: name.trim() || 'Untitled provider',
      baseUrl: normalizeBaseUrl(baseUrl),
      model: model.trim(),
      apiKey: apiKey.trim() || undefined,
      temperature: Number.isFinite(temp) ? temp : 0.7,
      maxTokens: maxTok !== null && Number.isFinite(maxTok) ? maxTok : null,
    };

    if (isNew) {
      const created = await createProfile(input);
      await setActiveProfile(created.id);
    } else {
      await updateProfile(id, input);
    }
    router.back();
  };

  const onDelete = () => {
    if (isNew) return;
    Alert.alert('Delete provider', `Delete "${existing?.name ?? 'this provider'}" and its API key?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await removeProfile(id);
          router.back();
        },
      },
    ]);
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: isNew ? 'Add provider' : 'Edit provider' }} />

      <Field
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="9router (home)"
        autoCapitalize="words"
      />

      <Field
        label="Base URL"
        hint='Include the /v1 suffix. AgentKey adds it if you leave it off, and assumes http:// when no scheme is given.'
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="http://192.168.1.10:20128/v1"
        keyboardType="url"
      />

      <Field
        label="API key"
        hint={
          existing?.hasApiKey
            ? `A key is stored${storedKeyMask ? ` (${storedKeyMask})` : ''}. Leave blank to keep it.`
            : 'Stored in the Android keystore via expo-secure-store, never in the chat database.'
        }
        value={apiKey}
        onChangeText={setApiKey}
        placeholder={existing?.hasApiKey ? '•••••••• (unchanged)' : 'sk-...'}
        secureTextEntry
      />

      <Field
        label="Model"
        hint="Exactly the id your endpoint expects."
        value={model}
        onChangeText={setModel}
        placeholder="gpt-4o-mini"
      />

      {models.length > 0 ? (
        <View style={styles.modelList}>
          <Text style={styles.modelListLabel}>Models reported by the server</Text>
          <View style={styles.chips}>
            {models.slice(0, 40).map((m) => (
              <Pressable
                key={m}
                onPress={() => setModel(m)}
                style={[styles.chip, m === model && styles.chipActive]}
              >
                <Text style={[styles.chipText, m === model && { color: colors.accent }]}>{m}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.row}>
        <Field
          label="Temperature"
          value={temperature}
          onChangeText={setTemperature}
          keyboardType="numeric"
          style={{ flex: 1 }}
        />
        <Field
          label="Max tokens"
          hint="Blank = server default"
          value={maxTokens}
          onChangeText={setMaxTokens}
          keyboardType="numeric"
          placeholder="auto"
          style={{ flex: 1 }}
        />
      </View>

      {testResult ? <Banner tone={testResult.tone}>{testResult.text}</Banner> : null}

      <View style={{ gap: spacing.sm }}>
        <Button
          title="Test connection"
          variant="secondary"
          onPress={() => void onTest()}
          loading={testing}
        />
        <Button title="Save" onPress={() => void onSave()} />
        {!isNew ? <Button title="Delete provider" variant="danger" onPress={onDelete} /> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: 'row', gap: spacing.md },
  modelList: { marginBottom: spacing.lg },
  modelListLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    backgroundColor: colors.bgElevated,
  },
  chipActive: { borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 12 },
});
