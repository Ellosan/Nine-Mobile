import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useSettings } from '../src/state/settingsStore';
import { useChat } from '../src/state/chatStore';
import { colors, spacing } from '../src/ui/theme';

export default function RootLayout() {
  const hydrate = useSettings((s) => s.hydrate);
  const loadSessions = useChat((s) => s.loadSessions);

  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await hydrate();
        await loadSessions();
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrate, loadSessions]);

  if (!ready) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {bootError ? (
        <View style={styles.bootError}>
          <Text style={styles.bootErrorText}>Storage failed to open: {bootError}</Text>
        </View>
      ) : null}
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" options={{ title: 'AgentKey' }} />
        <Stack.Screen name="chat/[id]" options={{ title: 'Chat' }} />
        <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
        <Stack.Screen name="settings/profile/[id]" options={{ title: 'Provider' }} />
      </Stack>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  bootError: { backgroundColor: colors.danger, padding: spacing.md },
  bootErrorText: { color: '#fff', fontSize: 12 },
});
