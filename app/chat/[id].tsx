/** The chat screen: streaming transcript, composer, permission prompt. */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChat } from '../../src/state/chatStore';
import { selectActiveProfile, useSettings } from '../../src/state/settingsStore';
import { MessageBubble } from '../../src/ui/MessageBubble';
import { PermissionSheet } from '../../src/ui/PermissionSheet';
import { Banner, Empty } from '../../src/ui/components';
import { colors, radius, spacing } from '../../src/ui/theme';
import type { StoredMessage } from '../../src/types';

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const sessionId = typeof params.id === 'string' ? params.id : null;
  const insets = useSafeAreaInsets();

  const openSession = useChat((s) => s.openSession);
  const messages = useChat((s) => s.messages);
  const messagesLoaded = useChat((s) => s.messagesLoaded);
  const activeSessionId = useChat((s) => s.activeSessionId);
  const sessions = useChat((s) => s.sessions);
  const busy = useChat((s) => s.busy);
  const status = useChat((s) => s.status);
  const error = useChat((s) => s.error);
  const clearError = useChat((s) => s.clearError);
  const sendMessage = useChat((s) => s.sendMessage);
  const cancel = useChat((s) => s.cancel);
  const pendingPermission = useChat((s) => s.pendingPermission);
  const resolvePermission = useChat((s) => s.resolvePermission);

  const profile = useSettings(selectActiveProfile);

  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<StoredMessage>>(null);

  const title = useMemo(
    () => sessions.find((s) => s.id === sessionId)?.title ?? 'Chat',
    [sessions, sessionId]
  );

  useEffect(() => {
    if (sessionId && sessionId !== activeSessionId) void openSession(sessionId);
  }, [sessionId, activeSessionId, openSession]);

  // Keep the newest message in view as tokens stream in.
  useEffect(() => {
    if (messages.length === 0) return;
    const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(t);
  }, [messages.length, messages[messages.length - 1]?.content]);

  const onSend = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    void sendMessage(text);
  };

  const visible = messages.filter((m) => m.role !== 'system');

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title }} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <FlatList
          ref={listRef}
          data={visible}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <MessageBubble message={item} />}
          contentContainerStyle={
            visible.length === 0
              ? { flexGrow: 1, justifyContent: 'center' }
              : { padding: spacing.lg, paddingBottom: spacing.xl }
          }
          ListEmptyComponent={
            messagesLoaded ? (
              <Empty
                title={profile ? 'Ask it something' : 'No provider configured'}
                body={
                  profile
                    ? `Talking to ${profile.model} at ${profile.baseUrl}. File tools are scoped to the working directory you granted in Settings.`
                    : 'Open Settings and add a base URL, API key and model name first.'
                }
              />
            ) : null
          }
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => {
            if (visible.length > 0) listRef.current?.scrollToEnd({ animated: false });
          }}
        />

        <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          {error ? (
            <View style={{ paddingHorizontal: spacing.lg }}>
              <Banner tone="danger" onDismiss={clearError}>
                {error}
              </Banner>
            </View>
          ) : null}

          {status ? (
            <View style={styles.statusRow}>
              <Text style={styles.statusText}>{status}</Text>
              <Pressable onPress={cancel} hitSlop={10}>
                <Text style={styles.cancel}>Stop</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.composer}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={busy ? 'Working...' : 'Message'}
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              multiline
              editable={!busy}
            />
            <Pressable
              onPress={onSend}
              disabled={busy || !draft.trim()}
              style={({ pressed }) => [
                styles.send,
                (busy || !draft.trim()) && { opacity: 0.4 },
                pressed && { opacity: 0.7 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Send message"
            >
              <Text style={styles.sendText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <PermissionSheet call={pendingPermission?.call ?? null} onDecide={resolvePermission} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  composerWrap: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
    paddingTop: spacing.sm,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  statusText: { color: colors.textMuted, fontSize: 12 },
  cancel: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    color: colors.text,
    fontSize: 15,
    maxHeight: 140,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 46,
    justifyContent: 'center',
  },
  sendText: { color: '#03121F', fontWeight: '700', fontSize: 15 },
});
