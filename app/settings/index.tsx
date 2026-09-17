/** Settings: provider profiles, working directory, agent tool switches. */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { selectActiveProfile, useSettings } from '../../src/state/settingsStore';
import {
  clearWorkspace,
  isWorkspaceSupported,
  requestWorkspaceDirectory,
  workspaceLabel,
} from '../../src/storage/workspace';
import { getShellAvailability, type ShellAvailability } from '../../src/agent/termux';
import { Banner, Button, Card, Field, SectionTitle, Toggle } from '../../src/ui/components';
import { colors, radius, spacing } from '../../src/ui/theme';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();

  const profiles = useSettings((s) => s.profiles);
  const activeProfileId = useSettings((s) => s.activeProfileId);
  const setActiveProfile = useSettings((s) => s.setActiveProfile);
  const active = useSettings(selectActiveProfile);

  const workspaceRoot = useSettings((s) => s.workspaceRoot);
  const setWorkspaceRootState = useSettings((s) => s.setWorkspaceRoot);

  const fileToolsEnabled = useSettings((s) => s.fileToolsEnabled);
  const setFileToolsEnabled = useSettings((s) => s.setFileToolsEnabled);
  const shellToolEnabled = useSettings((s) => s.shellToolEnabled);
  const setShellToolEnabled = useSettings((s) => s.setShellToolEnabled);

  const systemPrompt = useSettings((s) => s.systemPrompt);
  const setSystemPrompt = useSettings((s) => s.setSystemPrompt);
  const maxIterations = useSettings((s) => s.maxIterations);
  const setMaxIterations = useSettings((s) => s.setMaxIterations);

  const [shell, setShell] = useState<ShellAvailability | null>(null);
  const [promptDraft, setPromptDraft] = useState(systemPrompt);
  const [iterDraft, setIterDraft] = useState(String(maxIterations));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setPromptDraft(systemPrompt), [systemPrompt]);
  useEffect(() => setIterDraft(String(maxIterations)), [maxIterations]);

  useFocusEffect(
    useCallback(() => {
      void getShellAvailability().then(setShell);
    }, [])
  );

  const onPickDirectory = async () => {
    try {
      const uri = await requestWorkspaceDirectory();
      if (uri) {
        await setWorkspaceRootState(uri);
        setNotice(`Working directory set to ${workspaceLabel(uri)}`);
      }
    } catch (err) {
      Alert.alert('Could not set the working directory', String(err));
    }
  };

  const onClearDirectory = async () => {
    await clearWorkspace();
    await setWorkspaceRootState(null);
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}
      keyboardShouldPersistTaps="handled"
    >
      {notice ? (
        <Banner tone="info" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}

      <SectionTitle>Providers</SectionTitle>
      <Text style={styles.blurb}>
        The only credential AgentKey needs is an API key plus the base URL of an OpenAI-compatible
        endpoint. There is no account, no pairing and no second login.
      </Text>

      {profiles.length === 0 ? (
        <Card>
          <Text style={styles.emptyText}>No providers yet.</Text>
        </Card>
      ) : (
        profiles.map((p) => {
          const isActive = p.id === activeProfileId;
          return (
            <Pressable
              key={p.id}
              onPress={() => void setActiveProfile(p.id)}
              onLongPress={() => router.push(`/settings/profile/${p.id}`)}
              style={[styles.profileRow, isActive && styles.profileRowActive]}
            >
              <View style={styles.radio}>
                {isActive ? <View style={styles.radioDot} /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.profileName}>{p.name}</Text>
                <Text style={styles.profileMeta} numberOfLines={1}>
                  {p.model || 'no model'} · {p.baseUrl || 'no base URL'}
                </Text>
                {!p.hasApiKey ? <Text style={styles.warnText}>No API key stored</Text> : null}
              </View>
              <Pressable
                onPress={() => router.push(`/settings/profile/${p.id}`)}
                hitSlop={10}
                accessibilityLabel={`Edit ${p.name}`}
              >
                <Text style={styles.edit}>Edit</Text>
              </Pressable>
            </Pressable>
          );
        })
      )}

      <Button
        title="Add provider"
        variant="secondary"
        onPress={() => router.push('/settings/profile/new')}
        style={{ marginTop: spacing.md }}
      />

      <SectionTitle>Working directory</SectionTitle>
      <Text style={styles.blurb}>
        Android sandboxes apps, so the file tools can only see one folder you explicitly grant
        through the system picker. Everything read_file, write_file and list_files do is confined to
        it; paths with ".." or a leading "/" are rejected.
      </Text>
      <Card>
        <Text style={styles.wsLabel}>Granted folder</Text>
        <Text style={styles.wsValue} numberOfLines={2}>
          {workspaceLabel(workspaceRoot)}
        </Text>
        <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
          <Button
            title={workspaceRoot ? 'Choose a different folder' : 'Choose folder'}
            onPress={() => void onPickDirectory()}
            variant="secondary"
            disabled={!isWorkspaceSupported()}
          />
          {workspaceRoot ? (
            <Button title="Revoke" variant="danger" onPress={() => void onClearDirectory()} />
          ) : null}
        </View>
      </Card>

      <SectionTitle>Agent tools</SectionTitle>
      <Toggle
        label="File tools"
        hint="read_file, list_files and write_file, scoped to the folder above."
        value={fileToolsEnabled}
        onValueChange={(v) => void setFileToolsEnabled(v)}
      />
      <Toggle
        label="Shell tool"
        hint={
          shell?.available
            ? 'run_shell_command is wired up through the Termux bridge.'
            : (shell?.reason ??
              'Checking whether shell execution is possible on this device...')
        }
        value={shellToolEnabled}
        onValueChange={(v) => void setShellToolEnabled(v)}
      />
      {shellToolEnabled && shell && !shell.available ? (
        <Banner tone="warn">
          The shell tool is advertised to the model, but every call will return "unavailable" on this
          build. See the README section on shell access.
        </Banner>
      ) : null}

      <Field
        label="Tool rounds per turn"
        hint="How many times the model may call tools and see results before AgentKey stops the loop."
        value={iterDraft}
        onChangeText={setIterDraft}
        keyboardType="numeric"
        style={{ marginTop: spacing.lg }}
      />
      <Button
        title="Save limit"
        variant="secondary"
        onPress={() => {
          const n = Number.parseInt(iterDraft, 10);
          if (Number.isFinite(n)) void setMaxIterations(n);
        }}
      />

      <SectionTitle>System prompt</SectionTitle>
      <Field
        label="Sent at the top of every conversation"
        value={promptDraft}
        onChangeText={setPromptDraft}
        multiline
        numberOfLines={10}
      />
      <Button
        title="Save system prompt"
        variant="secondary"
        onPress={() => void setSystemPrompt(promptDraft)}
      />

      <SectionTitle>About</SectionTitle>
      <Text style={styles.blurb}>
        AgentKey {active ? `is talking to ${active.model}.` : 'has no active provider.'} Chats and
        settings stay on this device; API keys are held in the Android keystore through
        expo-secure-store.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  blurb: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  emptyText: { color: colors.textMuted, fontSize: 14 },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.bgElevated,
  },
  profileRowActive: { borderColor: colors.accent },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  profileName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  profileMeta: { color: colors.textFaint, fontSize: 12, marginTop: 2 },
  warnText: { color: colors.warn, fontSize: 12, marginTop: 2 },
  edit: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  wsLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  wsValue: { color: colors.text, fontSize: 14, marginTop: spacing.xs },
});
