'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseMarkdown, parseInline } = require('../.test-build/util/markdown');
const { highlight, isHighlightable } = require('../.test-build/util/highlight');
const { normalizeRelPath, PathError, mimeTypeFor } = require('../.test-build/util/path');

const text = (nodes) => nodes.map((n) => n.value).join('');

test('parses headings, paragraphs and rules', () => {
  const b = parseMarkdown('# Title\n\nSome text here.\n\n---\n');
  assert.deepStrictEqual(b.map((x) => x.type), ['heading', 'paragraph', 'rule']);
  assert.strictEqual(b[0].level, 1);
  assert.strictEqual(text(b[0].children), 'Title');
  assert.strictEqual(text(b[1].children), 'Some text here.');
});

test('parses a fenced code block with a language tag', () => {
  const b = parseMarkdown('Here:\n\n```ts\nconst x: number = 1;\n```\n\nDone.');
  assert.deepStrictEqual(b.map((x) => x.type), ['paragraph', 'code', 'paragraph']);
  assert.strictEqual(b[1].lang, 'ts');
  assert.strictEqual(b[1].value, 'const x: number = 1;');
});

test('keeps markdown syntax inside a code block literal', () => {
  const b = parseMarkdown('```md\n# not a heading\n**not bold**\n```');
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].type, 'code');
  assert.strictEqual(b[0].value, '# not a heading\n**not bold**');
});

test('handles an unterminated code fence (mid-stream rendering)', () => {
  const b = parseMarkdown('```py\nprint(1)\nprint(2)');
  assert.strictEqual(b[0].type, 'code');
  assert.strictEqual(b[0].value, 'print(1)\nprint(2)');
});

test('parses nested fences of different lengths', () => {
  const b = parseMarkdown('````\n```\ninner\n```\n````');
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].value, '```\ninner\n```');
});

test('parses lists', () => {
  const ul = parseMarkdown('- one\n- two\n- three');
  assert.strictEqual(ul[0].type, 'list');
  assert.strictEqual(ul[0].ordered, false);
  assert.deepStrictEqual(ul[0].items.map((i) => text(i.children)), ['one', 'two', 'three']);

  const ol = parseMarkdown('3. c\n4. d');
  assert.strictEqual(ol[0].ordered, true);
  assert.strictEqual(ol[0].start, 3);
});

test('parses blockquotes containing other blocks', () => {
  const b = parseMarkdown('> # quoted\n> body');
  assert.strictEqual(b[0].type, 'quote');
  assert.deepStrictEqual(b[0].children.map((c) => c.type), ['heading', 'paragraph']);
});

test('inline: bold, italic, strike, code and links', () => {
  const bold = parseInline('a **b** c');
  assert.strictEqual(bold.find((n) => n.bold).value, 'b');

  const ital = parseInline('a *b* c');
  assert.strictEqual(ital.find((n) => n.italic).value, 'b');

  const st = parseInline('~~gone~~');
  assert.strictEqual(st[0].strike, true);

  const code = parseInline('use `npm install` now');
  assert.strictEqual(code.find((n) => n.code).value, 'npm install');

  const link = parseInline('see [docs](https://x.dev)');
  const l = link.find((n) => n.href);
  assert.strictEqual(l.href, 'https://x.dev');
  assert.strictEqual(l.value, 'docs');
});

test('inline code wins over emphasis', () => {
  const nodes = parseInline('`**literal**`');
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].code, true);
  assert.strictEqual(nodes[0].value, '**literal**');
});

test('does not italicise arithmetic', () => {
  const nodes = parseInline('2 * 3 * 4');
  assert.strictEqual(nodes.some((n) => n.italic), false);
  assert.strictEqual(text(nodes), '2 * 3 * 4');
});

test('inline parsing never loses characters', () => {
  for (const s of [
    'plain',
    '**a** and *b* and `c`',
    'unclosed **bold',
    'a_b_c',
    '[broken](',
    '~~x~~ y',
  ]) {
    assert.ok(text(parseInline(s)).length > 0, s);
  }
});

test('highlighter covers the whole input exactly', () => {
  const samples = [
    ['ts', 'const x = 1; // hi\nfunction f(a) { return "s"; }'],
    ['py', 'def f(a):\n    # c\n    return "x"'],
    ['bash', 'echo "hi" # comment\ncd $HOME'],
    ['json', '{"a": 1, "b": true, "c": null}'],
    ['html', '<div class="x">text</div>'],
    ['css', '.a { color: red; }'],
    ['unknownlang', 'whatever this is'],
  ];
  for (const [lang, code] of samples) {
    const tokens = highlight(code, lang);
    assert.strictEqual(tokens.map((t) => t.value).join(''), code, `round-trip failed for ${lang}`);
  }
});

test('highlighter does not treat keywords inside strings or comments as code', () => {
  const tokens = highlight('const s = "return function"; // return', 'ts');
  const str = tokens.find((t) => t.kind === 'string');
  assert.strictEqual(str.value, '"return function"');
  assert.ok(tokens.some((t) => t.kind === 'comment' && t.value === '// return'));
  assert.ok(tokens.some((t) => t.kind === 'keyword' && t.value === 'const'));
});

test('language detection', () => {
  assert.strictEqual(isHighlightable('tsx'), true);
  assert.strictEqual(isHighlightable('python'), true);
  assert.strictEqual(isHighlightable('brainfuck'), false);
});

test('path normalisation rejects everything that escapes the workspace', () => {
  assert.strictEqual(normalizeRelPath('src/a.ts'), 'src/a.ts');
  assert.strictEqual(normalizeRelPath('./src//b.ts'), 'src/b.ts');
  assert.strictEqual(normalizeRelPath('a/b/../c.ts'), 'a/c.ts');
  assert.strictEqual(normalizeRelPath('a\\b.ts'), 'a/b.ts');

  for (const bad of ['/etc/passwd', '../outside', 'a/../../b', '~/x', 'C:\\x', 'file:///etc', '', '   ', '.']) {
    assert.throws(() => normalizeRelPath(bad), PathError, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('mime types avoid SAF renaming source files', () => {
  assert.strictEqual(mimeTypeFor('a.md'), 'text/plain');
  assert.strictEqual(mimeTypeFor('a.json'), 'application/json');
  assert.strictEqual(mimeTypeFor('a.ts'), 'application/octet-stream');
});
