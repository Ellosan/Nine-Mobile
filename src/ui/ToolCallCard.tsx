/** Shows a tool call attached to an assistant message, with its live status. */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StoredToolCall, ToolCallStatus } from '../types';
import { colors, fonts, radius, spacing } from './theme';

const STATUS_META: Record<ToolCallStatus, { label: string; color: string }> = {
  pending: { label: 'queued', color: colors.textFaint },
  awaiting: { label: 'needs approval', color: colors.warn },
  running: { label: 'running', color: colors.accent },
  ok: { label: 'done', color: colors.success },
  error: { label: 'failed', color: colors.danger },
  denied: { label: 'denied', color: colors.danger },
};

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), null, 2);
  } catch {
    return raw;
  }
}

export function ToolCallCard({ call }: { call: StoredToolCall }) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[call.status] ?? STATUS_META.pending;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={styles.header}
        accessibilityRole="button"
        accessibilityLabel={`Tool ${call.name}, ${meta.label}`}
      >
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
        <Text style={styles.name} numberOfLines={1}>
          {call.name}
        </Text>
        <View style={[styles.badge, { borderColor: meta.color }]}>
          <Text style={[styles.badgeText, { color: meta.color }]}>{meta.label}</Text>
        </View>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          <Text style={styles.sectionLabel}>arguments</Text>
          <Text style={styles.mono} selectable>
            {prettyArgs(call.arguments)}
          </Text>
          {call.result ? (
            <>
              <Text style={[styles.sectionLabel, { marginTop: spacing.md }]}>result</Text>
              <Text style={styles.mono} selectable>
                {call.result.length > 4000 ? `${call.result.slice(0, 4000)}\n...` : call.result}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chevron: { color: colors.textFaint, fontSize: 12, width: 12 },
  name: { color: colors.text, fontFamily: fonts.mono, fontSize: 13, flex: 1 },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  body: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  sectionLabel: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.xs,
  },
  mono: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    lineHeight: 17,
  },
});
