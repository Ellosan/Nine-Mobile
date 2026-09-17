/** A fenced code block: horizontal scroll, language chip, copy button. */

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { highlight } from '../util/highlight';
import { colors, fonts, radius, spacing, syntaxColors } from './theme';

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const tokens = useMemo(() => highlight(code, lang), [code, lang]);
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.lang}>{lang || 'text'}</Text>
        <Pressable onPress={onCopy} hitSlop={8} accessibilityRole="button">
          <Text style={styles.copy}>{copied ? 'copied' : 'copy'}</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        contentContainerStyle={styles.codeScroll}
      >
        <Text style={styles.code} selectable>
          {tokens.map((t, i) => (
            <Text key={i} style={{ color: syntaxColors[t.kind] ?? syntaxColors.plain }}>
              {t.value}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.codeBg,
    borderColor: colors.codeBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    marginVertical: spacing.sm,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.codeBorder,
  },
  lang: {
    color: colors.textFaint,
    fontSize: 11,
    fontFamily: fonts.mono,
    textTransform: 'lowercase',
  },
  copy: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  codeScroll: { padding: spacing.md, minWidth: '100%' },
  code: { fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 19 },
});
