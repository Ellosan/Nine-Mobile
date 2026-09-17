/** Session list: the app's home screen. */

import React, { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChat } from '../src/state/chatStore';
import { selectActiveProfile, useSettings } from '../src/state/settingsStore';
import { Button, Card, Empty } from '../src/ui/components';
import { colors, radius, spacing } from '../src/ui/theme';
import type { ChatSession } from '../src/types';

export default function SessionListScreen() {
  const insets = useSafeAreaInsets();
  const sessions = useChat((s) => s.sessions);
  const loadSessions = useChat((s) => s.loadSessions);
  const createSession = useChat((s) => s.createSession);
  const deleteSession = useChat((s) => s.deleteSession);
  const renameSession = useChat((s) => s.renameSession);

  const profile = useSettings(selectActiveProfile);
  const profileCount = useSettings((s) => s.profiles.length);

  const [renaming, setRenaming] = useState<ChatSession | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  useFocusEffect(
    useCallback(() => {
      void loadSessions();
    }, [loadSessions])
  );

  const onNewChat = async () => {
    const session = await createSession();
    router.push(`/chat/${session.id}`);
  };

  const onDelete = (session: ChatSession) => {
    Alert.alert('Delete chat', `Delete "${session.title}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void deleteSession(session.id),
      },
    ]);
  };

  const commitRename = async () => {
    if (renaming && draftTitle.trim()) {
      await renameSession(renaming.id, draftTitle);
    }
    setRenaming(null);
  };

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => router.push('/settings')} style={styles.providerChip}>
          <Text style={styles.providerLabel} numberOfLines={1}>
            {profile ? `${profile.name} · ${profile.model}` : 'No provider configured'}
          </Text>
          <Text style={styles.providerAction}>Settings</Text>
        </Pressable>
      </View>

      {profileCount === 0 ? (
        <Card style={{ marginHorizontal: spacing.lg, marginBottom: spacing.lg }}>
          <Text style={styles.setupTitle}>Add a provider to get started</Text>
          <Text style={styles.setupBody}>
            AgentKey only needs a base URL, an API key and a model name. For 9router that is
            something like http://192.168.1.10:20128/v1.
          </Text>
          <Button
            title="Open Settings"
            onPress={() => router.push('/settings')}
            style={{ marginTop: spacing.md }}
          />
        </Card>
      ) : null}

      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={
          sessions.length === 0
            ? { flexGrow: 1, justifyContent: 'center' }
            : { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }
        }
        ListEmptyComponent={
          <Empty title="No chats yet" body="Start one and it will be saved on this device." />
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/chat/${item.id}`)}
            onLongPress={() => {
              setRenaming(item);
              setDraftTitle(item.title);
            }}
            style={({ pressed }) => [styles.sessionRow, pressed && { opacity: 0.7 }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.sessionTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.sessionMeta}>{formatWhen(item.updatedAt)}</Text>
            </View>
            <Pressable onPress={() => onDelete(item)} hitSlop={12} accessibilityLabel="Delete chat">
              <Text style={styles.delete}>Delete</Text>
            </Pressable>
          </Pressable>
        )}
      />

      <View style={styles.footer}>
        <Button title="New chat" onPress={() => void onNewChat()} />
      </View>

      <Modal visible={renaming !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename chat</Text>
            <TextInput
              value={draftTitle}
              onChangeText={setDraftTitle}
              autoFocus
              style={styles.modalInput}
              placeholderTextColor={colors.textFaint}
            />
            <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
              <Button title="Save" onPress={() => void commitRename()} />
              <Button title="Cancel" variant="ghost" onPress={() => setRenaming(null)} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  providerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  providerLabel: { color: colors.textMuted, fontSize: 13, flex: 1 },
  providerAction: { color: colors.accent, fontSize: 13, fontWeight: '600' },

  setupTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: spacing.sm },
  setupBody: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },

  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sessionTitle: { color: colors.text, fontSize: 15, marginBottom: 2 },
  sessionMeta: { color: colors.textFaint, fontSize: 12 },
  delete: { color: colors.danger, fontSize: 13 },

  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modalCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: spacing.md },
  modalInput: {
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 15,
  },
});
