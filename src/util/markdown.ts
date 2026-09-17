/**
 * A small, dependency-free Markdown parser producing a tree the RN renderer
 * can walk.
 *
 * Why not react-native-markdown-display: it pulls in markdown-it@10 plus an
 * image library, and we need very tight control over fenced code blocks (the
 * one element that actually matters for a coding agent). This covers the subset
 * an LLM actually emits.
 */

export interface InlineText {
  type: 'text';
  value: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
}

export type InlineNode = InlineText;

export interface HeadingBlock {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: InlineNode[];
}

export interface ParagraphBlock {
  type: 'paragraph';
  children: InlineNode[];
}

export interface CodeBlock {
  type: 'code';
  lang: string;
  value: string;
}

export interface QuoteBlock {
  type: 'quote';
  children: Block[];
}

export interface ListItem {
  children: InlineNode[];
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  start: number;
  items: ListItem[];
}

export interface RuleBlock {
  type: 'rule';
}

export type Block = HeadingBlock | ParagraphBlock | CodeBlock | QuoteBlock | ListBlock | RuleBlock;

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

/** Parse a Markdown document into blocks. */
export function parseMarkdown(src: string): Block[] {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n');
  return parseLines(lines);
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2] as string;
      const lang = (fence[3] ?? '').toLowerCase();
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const cur = lines[i] as string;
        const closing = FENCE_RE.exec(cur);
        // A closing fence must use the same character and be at least as long.
        if (
          closing &&
          (closing[2] as string)[0] === marker[0] &&
          (closing[2] as string).length >= marker.length &&
          !(closing[3] ?? '')
        ) {
          closed = true;
          i++;
          break;
        }
        body.push(cur);
        i++;
      }
      void closed;
      blocks.push({ type: 'code', lang, value: body.join('\n') });
      continue;
    }

    // Heading
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(6, (heading[1] as string).length) as HeadingBlock['level'];
      blocks.push({ type: 'heading', level, children: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    // Horizontal rule (checked before lists so "---" is not a bullet)
    if (RULE_RE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    // Blockquote: gather the run, strip markers, recurse.
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i] as string)) {
        const m = QUOTE_RE.exec(lines[i] as string);
        inner.push(m?.[1] ?? '');
        i++;
      }
      blocks.push({ type: 'quote', children: parseLines(inner) });
      continue;
    }

    // Lists
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const start = ordered ? Number.parseInt(ol?.[2] ?? '1', 10) : 1;
      const items: ListItem[] = [];

      while (i < lines.length) {
        const cur = lines[i] as string;
        const mu = UL_RE.exec(cur);
        const mo = OL_RE.exec(cur);
        if (ordered && mo) {
          items.push({ children: parseInline(mo[3] ?? '') });
          i++;
        } else if (!ordered && mu) {
          items.push({ children: parseInline(mu[2] ?? '') });
          i++;
        } else if (
          cur.trim() !== '' &&
          /^\s{2,}\S/.test(cur) &&
          items.length > 0 &&
          !FENCE_RE.test(cur)
        ) {
          // Continuation line of the previous item.
          const last = items[items.length - 1] as ListItem;
          last.children.push(...parseInline(` ${cur.trim()}`));
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', ordered, start: Number.isFinite(start) ? start : 1, items });
      continue;
    }

    // Paragraph: consume until a blank line or a line that starts a new block.
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] as string;
      if (
        cur.trim() === '' ||
        FENCE_RE.test(cur) ||
        HEADING_RE.test(cur) ||
        RULE_RE.test(cur) ||
        QUOTE_RE.test(cur) ||
        UL_RE.test(cur) ||
        OL_RE.test(cur)
      ) {
        break;
      }
      para.push(cur.trim());
      i++;
    }
    if (para.length > 0) {
      blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) });
    }
  }

  return blocks;
}

/* ------------------------------------------------------------------ */
/* Inline parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Parse inline markup. Code spans win over everything (so `**a**` inside
 * backticks stays literal), then links, then emphasis.
 */
export function parseInline(src: string): InlineNode[] {
  const out: InlineNode[] = [];
  if (!src) return out;

  let i = 0;
  let buffer = '';

  const flush = () => {
    if (buffer) {
      out.push(...parseEmphasis(buffer));
      buffer = '';
    }
  };

  while (i < src.length) {
    const c = src[i] as string;

    // Escape
    if (c === '\\' && i + 1 < src.length) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }

    // Code span
    if (c === '`') {
      let ticks = 0;
      while (src[i + ticks] === '`') ticks++;
      const fence = '`'.repeat(ticks);
      const close = src.indexOf(fence, i + ticks);
      if (close !== -1) {
        flush();
        out.push({ type: 'text', value: src.slice(i + ticks, close), code: true });
        i = close + ticks;
        continue;
      }
      buffer += c;
      i++;
      continue;
    }

    // Link [text](href)
    if (c === '[') {
      const close = findClosing(src, i, '[', ']');
      if (close !== -1 && src[close + 1] === '(') {
        const parenClose = findClosing(src, close + 1, '(', ')');
        if (parenClose !== -1) {
          flush();
          const label = src.slice(i + 1, close);
          const href = src.slice(close + 2, parenClose).trim();
          const inner = parseInline(label);
          for (const node of inner) out.push({ ...node, href });
          i = parenClose + 1;
          continue;
        }
      }
    }

    buffer += c;
    i++;
  }
  flush();
  return out;
}

/** Index of the matching close char, or -1. Handles nesting. */
function findClosing(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * If `src` starts with one of `delims`, find the matching closing delimiter and
 * return the content between them.
 *
 * Mirrors CommonMark's flanking rule closely enough for LLM output: the opening
 * delimiter may not be followed by whitespace and the closing one may not be
 * preceded by it, so `2 * 3 * 4` is not italics.
 */
function matchDelimited(
  src: string,
  delims: string[]
): { inner: string; length: number } | null {
  for (const d of delims) {
    if (!src.startsWith(d)) continue;

    const afterOpen = src[d.length];
    if (afterOpen === undefined || /\s/.test(afterOpen)) continue;

    let search = d.length + 1;
    for (;;) {
      const close = src.indexOf(d, search);
      if (close === -1) break;

      const beforeClose = src[close - 1] as string;
      if (/\s/.test(beforeClose)) {
        search = close + 1;
        continue;
      }
      // For single-char delimiters, "**" is a stronger match handled earlier.
      return { inner: src.slice(d.length, close), length: close + d.length };
    }
  }
  return null;
}

/** Handles **bold**, *italic*, __bold__, _italic_ and ~~strike~~. */
function parseEmphasis(src: string): InlineNode[] {
  const out: InlineNode[] = [];
  let i = 0;
  let buffer = '';

  const push = (value: string, style?: Partial<InlineText>) => {
    if (!value) return;
    out.push({ type: 'text', value, ...style });
  };

  const flush = () => {
    push(buffer);
    buffer = '';
  };

  while (i < src.length) {
    const rest = src.slice(i);

    // NOTE: no lookbehind assertions anywhere in this file -- Hermes support
    // for them is inconsistent across React Native versions, so the
    // "delimiter is not adjacent to whitespace" rule is checked by hand.
    const strong = matchDelimited(rest, ['**', '__']);
    if (strong) {
      flush();
      for (const node of parseEmphasis(strong.inner)) {
        out.push({ ...node, bold: true });
      }
      i += strong.length;
      continue;
    }

    const strike = matchDelimited(rest, ['~~']);
    if (strike) {
      flush();
      for (const node of parseEmphasis(strike.inner)) {
        out.push({ ...node, strike: true });
      }
      i += strike.length;
      continue;
    }

    const em = matchDelimited(rest, ['*', '_']);
    if (em) {
      flush();
      for (const node of parseEmphasis(em.inner)) {
        out.push({ ...node, italic: true });
      }
      i += em.length;
      continue;
    }

    buffer += src[i];
    i++;
  }

  flush();
  return out;
}

/** Plain text of a document, used for copy-to-clipboard and titles. */
export function blocksToPlainText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
      case 'paragraph':
        parts.push(b.children.map((c) => c.value).join(''));
        break;
      case 'code':
        parts.push(b.value);
        break;
      case 'quote':
        parts.push(blocksToPlainText(b.children));
        break;
      case 'list':
        parts.push(b.items.map((it) => it.children.map((c) => c.value).join('')).join('\n'));
        break;
      case 'rule':
        parts.push('---');
        break;
    }
  }
  return parts.join('\n\n');
}
