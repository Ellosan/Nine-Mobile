/**
 * The approval prompt shown before a write_file or run_shell_command call.
 *
 * The agent loop is genuinely blocked on the promise behind this sheet, so the
 * tool cannot run until the user taps something. There is no auto-allow path
 * and no timeout that defaults to "yes".
 */

import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ToolCall } from '../types';
import { describeToolCall } from '../agent/executor';
import { TOOL_RUN_SHELL } from '../agent/toolSchemas';
import type { PermissionDecision } from '../agent/loop';
import { Button } from './components';
import { colors, fonts, radius, spacing } from './theme';

export function PermissionSheet({
  call,
  onDecide,
}: {
  call: ToolCall | null;
  onDecide: (decision: PermissionDecision) => void;
}) {
  if (!call) return null;

  const { title, detail } = describeToolCall(call);
  const isShell = call.function.name === TOOL_RUN_SHELL;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={() => onDecide('deny')}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.grabber} />

          <Text style={styles.eyebrow}>
            {isShell ? 'Shell command requested' : 'File write requested'}
          </Text>
          <Text style={styles.title}>{title}</Text>

          {detail ? (
            <ScrollView style={styles.detailBox} contentContainerStyle={{ padding: spacing.md }}>
              <Text style={styles.detail} selectable>
                {detail}
              </Text>
            </ScrollView>
          ) : null}

          <Text style={styles.note}>
            {isShell
              ? 'Commands run outside AgentKey, through the Termux bridge.'
              : 'This writes inside the working directory you granted. Existing content is replaced.'}
          </Text>

          <View style={styles.actions}>
            <Button title="Deny" variant="danger" onPress={() => onDecide('deny')} />
            <Button title="Allow once" variant="secondary" onPress={() => onDecide('allow')} />
            <Button
              title={`Allow ${call.function.name} for this turn`}
              variant="primary"
              onPress={() => onDecide('allow_session')}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    maxHeight: '85%',
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    alignSelf: 'center',
    marginBottom: spacing.lg,
  },
  eyebrow: {
    color: colors.warn,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.xs,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  detailBox: {
    backgroundColor: colors.codeBg,
    borderColor: colors.codeBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    maxHeight: 260,
    marginBottom: spacing.md,
  },
  detail: { color: colors.textMuted, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  note: { color: colors.textFaint, fontSize: 12, lineHeight: 17, marginBottom: spacing.lg },
  actions: { gap: spacing.sm },
});
