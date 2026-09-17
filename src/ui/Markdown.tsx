/** Renders the block tree from util/markdown into React Native views. */

import React, { useMemo } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { parseMarkdown, type Block, type InlineNode } from '../util/markdown';
import { CodeBlock } from './CodeBlock';
import { colors, fonts, radius, spacing } from './theme';

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <BlockList blocks={blocks} />;
}

function BlockList({ blocks }: { blocks: Block[] }) {
  return (
    <View>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </View>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading': {
      const size = [22, 19, 17, 16, 15, 14][block.level - 1] ?? 15;
      return (
        <Text style={[styles.heading, { fontSize: size }]} selectable>
          <Inline nodes={block.children} />
        </Text>
      );
    }
    case 'paragraph':
      return (
        <Text style={styles.paragraph} selectable>
          <Inline nodes={block.children} />
        </Text>
      );
    case 'code':
      return <CodeBlock code={block.value} lang={block.lang} />;
    case 'quote':
      return (
        <View style={styles.quote}>
          <BlockList blocks={block.children} />
        </View>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.listItem}>
              <Text style={styles.bullet}>
                {block.ordered ? `${block.start + i}.` : '•'}
              </Text>
              <Text style={styles.listText} selectable>
                <Inline nodes={item.children} />
              </Text>
            </View>
          ))}
        </View>
      );
    case 'rule':
      return <View style={styles.rule} />;
    default:
      return null;
  }
}

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        const style = [
          n.bold && styles.bold,
          n.italic && styles.italic,
          n.strike && styles.strike,
          n.code && styles.inlineCode,
          n.href && styles.link,
        ].filter(Boolean);

        if (n.href) {
          const href = n.href;
          return (
            <Text
              key={i}
              style={style}
              onPress={() => {
                void Linking.openURL(href).catch(() => {
                  /* an unopenable link should not crash the chat */
                });
              }}
            >
              {n.value}
            </Text>
          );
        }
        return (
          <Text key={i} style={style}>
            {n.value}
          </Text>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  heading: {
    color: colors.text,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    lineHeight: 28,
  },
  paragraph: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through', color: colors.textMuted },
  link: { color: colors.accent, textDecorationLine: 'underline' },
  inlineCode: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: '#FFA657',
    backgroundColor: colors.codeBg,
  },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.borderStrong,
    paddingLeft: spacing.md,
    marginVertical: spacing.sm,
  },
  list: { marginBottom: spacing.sm },
  listItem: { flexDirection: 'row', marginBottom: spacing.xs, paddingRight: spacing.sm },
  bullet: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    width: 24,
  },
  listText: { color: colors.text, fontSize: 15, lineHeight: 22, flex: 1 },
  rule: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
    borderRadius: radius.sm,
  },
});
