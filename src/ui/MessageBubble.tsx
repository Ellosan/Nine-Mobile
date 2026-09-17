/** One row in the chat transcript. */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StoredMessage } from '../types';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import { colors, fonts, radius, spacing } from './theme';

export function MessageBubble({ message }: { message: StoredMessage }) {
  if (message.role === 'user') return <UserBubble message={message} />;
  if (message.role === 'tool') return <ToolResultRow message={message} />;
  if (message.role === 'system') return null;
  return <AssistantBubble message={message} />;
}

function UserBubble({ message }: { message: StoredMessage }) {
  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text style={styles.userText} selectable>
          {message.content}
        </Text>
      </View>
    </View>
  );
}

function AssistantBubble({ message }: { message: StoredMessage }) {
  const empty = !message.content && !message.error;

  return (
    <View style={styles.assistantRow}>
      {empty && message.streaming ? (
        <Text style={styles.thinking}>thinking...</Text>
      ) : (
        <Markdown source={message.content} />
      )}

      {message.streaming && message.content ? <Text style={styles.caret}>▍</Text> : null}

      {message.toolCalls?.map((call) => (
        <ToolCallCard key={call.id} call={call} />
      ))}

      {message.error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText} selectable>
            {message.error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Tool output is collapsed by default: it is usually long, and the assistant's
 * next message normally summarises it anyway.
 */
function ToolResultRow({ message }: { message: StoredMessage }) {
  const [open, setOpen] = useState(false);
  const isError = message.content.startsWith('ERROR:') || message.content.startsWith('DENIED:');
  const firstLine = message.content.split('\n')[0] ?? '';

  return (
    <Pressable onPress={() => setOpen((v) => !v)} style={styles.toolRow}>
      <Text style={[styles.toolLabel, isError && { color: colors.danger }]} numberOfLines={1}>
        {open ? '▾' : '▸'} {message.toolName ?? 'tool'}
        {' → '}
        {open ? '' : firstLine.slice(0, 60)}
      </Text>
      {open ? (
        <Text style={styles.toolBody} selectable>
          {message.content.length > 6000
            ? `${message.content.slice(0, 6000)}\n...[truncated]`
            : message.content}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  userRow: { alignItems: 'flex-end', marginBottom: spacing.md },
  userBubble: {
    backgroundColor: colors.user,
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    maxWidth: '88%',
  },
  userText: { color: colors.text, fontSize: 15, lineHeight: 21 },

  assistantRow: { marginBottom: spacing.lg },
  thinking: { color: colors.textFaint, fontSize: 14, fontStyle: 'italic' },
  caret: { color: colors.accent, fontSize: 12 },

  errorBox: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  errorText: { color: colors.danger, fontSize: 13, lineHeight: 18 },

  toolRow: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong,
    paddingLeft: spacing.md,
    marginBottom: spacing.md,
  },
  toolLabel: { color: colors.textFaint, fontFamily: fonts.mono, fontSize: 11.5 },
  toolBody: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
});
