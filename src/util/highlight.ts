/**
 * A tiny, dependency-free syntax highlighter.
 *
 * It tokenises with one combined regex per language family and returns flat
 * spans. That is enough for readable code blocks on a phone, costs nothing at
 * install time, and cannot break when a highlighting library drops React Native
 * support. No lookbehind assertions (Hermes).
 */

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'builtin'
  | 'function'
  | 'operator'
  | 'punctuation'
  | 'tag'
  | 'attr';

export interface Token {
  kind: TokenKind;
  value: string;
}

type Family = 'c-like' | 'python' | 'shell' | 'markup' | 'json' | 'css' | 'plain';

const FAMILY_BY_LANG: Record<string, Family> = {
  js: 'c-like',
  jsx: 'c-like',
  javascript: 'c-like',
  mjs: 'c-like',
  cjs: 'c-like',
  ts: 'c-like',
  tsx: 'c-like',
  typescript: 'c-like',
  java: 'c-like',
  kotlin: 'c-like',
  kt: 'c-like',
  swift: 'c-like',
  c: 'c-like',
  h: 'c-like',
  cpp: 'c-like',
  cc: 'c-like',
  cxx: 'c-like',
  'c++': 'c-like',
  cs: 'c-like',
  csharp: 'c-like',
  go: 'c-like',
  rust: 'c-like',
  rs: 'c-like',
  php: 'c-like',
  dart: 'c-like',
  scala: 'c-like',
  groovy: 'c-like',

  py: 'python',
  python: 'python',
  rb: 'python',
  ruby: 'python',

  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  fish: 'shell',

  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',

  json: 'json',
  jsonc: 'json',
  json5: 'json',

  css: 'css',
  scss: 'css',
  less: 'css',
};

const KEYWORDS: Record<Exclude<Family, 'plain' | 'markup' | 'json'>, Set<string>> = {
  'c-like': new Set(
    ('abstract as async await break case catch class const continue debugger default delete do else ' +
      'enum export extends false final finally for from func fun function get go If implements import in ' +
      'instanceof interface internal let map new null override package private protected public readonly ' +
      'return set static struct super switch this throw throws trait true try type typeof union unsafe use ' +
      'val var void when where while with yield impl mut pub fn let match loop defer chan select range ' +
      'namespace using virtual template typename operator sizeof nil')
      .split(' ')
  ),
  python: new Set(
    ('and as assert async await break class continue def del elif else except False finally for from ' +
      'global if import in is lambda None nonlocal not or pass raise return True try while with yield ' +
      'begin end do elsif ensure module nil rescue self unless until require')
      .split(' ')
  ),
  shell: new Set(
    ('if then else elif fi for while until do done case esac function in select time coproc return ' +
      'break continue local export readonly declare unset shift source alias set trap exit')
      .split(' ')
  ),
  css: new Set('important media keyframes import supports charset font-face root and not only'.split(' ')),
};

const BUILTINS: Record<string, Set<string>> = {
  'c-like': new Set(
    ('console window document Math JSON Object Array String Number Boolean Promise Set Map Date RegExp ' +
      'Error undefined NaN Infinity require module exports process globalThis String println printf')
      .split(' ')
  ),
  python: new Set(
    ('print len range str int float list dict set tuple open enumerate zip map filter sum min max abs ' +
      'sorted isinstance type super self puts')
      .split(' ')
  ),
  shell: new Set(
    ('echo cd ls cat grep sed awk find git npm npx node python pip curl wget chmod chown mkdir rm cp mv ' +
      'touch tar ssh docker make sudo apt pkg')
      .split(' ')
  ),
};

function familyFor(lang: string): Family {
  return FAMILY_BY_LANG[(lang || '').toLowerCase()] ?? 'plain';
}

/** True if the language tag is one we can do anything useful with. */
export function isHighlightable(lang: string): boolean {
  return familyFor(lang) !== 'plain';
}

/**
 * One regex, alternation ordered by precedence: comments and strings first so
 * that keywords inside them are never highlighted.
 */
function patternFor(family: Family): RegExp | null {
  switch (family) {
    case 'c-like':
      return new RegExp(
        [
          '(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)', // 1 comment
          '(`(?:\\\\.|[^`\\\\])*`|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')', // 2 string
          '\\b(0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)\\b', // 3 number
          '([A-Za-z_$][\\w$]*)(?=\\s*\\()', // 4 call
          '([A-Za-z_$][\\w$]*)', // 5 word
          '([{}()\\[\\];,.])', // 6 punctuation
          '([+\\-*/%=<>!&|^~?:]+)', // 7 operator
        ].join('|'),
        'g'
      );
    case 'python':
      return new RegExp(
        [
          '(#[^\\n]*)',
          '("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')',
          '\\b(0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)\\b',
          '([A-Za-z_][\\w]*)(?=\\s*\\()',
          '([A-Za-z_][\\w]*)',
          '([{}()\\[\\];,.:])',
          '([+\\-*/%=<>!&|^~@]+)',
        ].join('|'),
        'g'
      );
    case 'shell':
      return new RegExp(
        [
          '(#[^\\n]*)',
          '("(?:\\\\.|[^"\\\\])*"|\'[^\']*\')',
          '\\b(\\d+)\\b',
          '(\\$\\{?[A-Za-z_][\\w]*\\}?)', // 4 -> treated as builtin-ish variable
          '([A-Za-z_][\\w-]*)',
          '([{}()\\[\\];,])',
          '([|&><=*!$]+)',
        ].join('|'),
        'g'
      );
    case 'json':
      return new RegExp(
        [
          '(\\/\\/[^\\n]*)',
          '("(?:\\\\.|[^"\\\\])*")',
          '\\b(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b',
          '\\b(true|false|null)\\b',
          '()', // keep group numbering aligned
          '([{}\\[\\],:])',
          '()',
        ].join('|'),
        'g'
      );
    case 'css':
      return new RegExp(
        [
          '(\\/\\*[\\s\\S]*?\\*\\/)',
          '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')',
          '\\b(-?\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?)\\b',
          '([.#]?[A-Za-z_-][\\w-]*)(?=\\s*\\{)',
          '([A-Za-z-]+)',
          '([{}();:,])',
          '([>+~*]+)',
        ].join('|'),
        'g'
      );
    default:
      return null;
  }
}

/** Markup gets its own simple pass: tags, attributes, strings, comments. */
function tokenizeMarkup(code: string): Token[] {
  const tokens: Token[] = [];
  const re = /(<!--[\s\S]*?-->)|(<\/?[A-Za-z][\w:-]*)|("[^"]*"|'[^']*')|([A-Za-z_:][\w:.-]*)(?==)|(\/?>)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(code)) !== null) {
    if (m.index > last) tokens.push({ kind: 'plain', value: code.slice(last, m.index) });
    if (m[1]) tokens.push({ kind: 'comment', value: m[1] });
    else if (m[2]) tokens.push({ kind: 'tag', value: m[2] });
    else if (m[3]) tokens.push({ kind: 'string', value: m[3] });
    else if (m[4]) tokens.push({ kind: 'attr', value: m[4] });
    else if (m[5]) tokens.push({ kind: 'tag', value: m[5] });
    last = re.lastIndex;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < code.length) tokens.push({ kind: 'plain', value: code.slice(last) });
  return tokens;
}

/** Tokenise `code` for display. Always returns tokens covering the whole input. */
export function highlight(code: string, lang: string): Token[] {
  const family = familyFor(lang);
  if (family === 'plain') return [{ kind: 'plain', value: code }];
  if (family === 'markup') return tokenizeMarkup(code);

  const re = patternFor(family);
  if (!re) return [{ kind: 'plain', value: code }];

  const keywords = (KEYWORDS as Record<string, Set<string>>)[family];
  const builtins = BUILTINS[family];

  const tokens: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(code)) !== null) {
    if (m.index > last) tokens.push({ kind: 'plain', value: code.slice(last, m.index) });

    if (m[1]) tokens.push({ kind: 'comment', value: m[1] });
    else if (m[2]) tokens.push({ kind: 'string', value: m[2] });
    else if (m[3]) tokens.push({ kind: 'number', value: m[3] });
    else if (m[4]) {
      // A call site in most families; a variable in shell; a literal in JSON.
      if (family === 'json') tokens.push({ kind: 'keyword', value: m[4] });
      else if (family === 'shell') tokens.push({ kind: 'builtin', value: m[4] });
      else if (keywords?.has(m[4])) tokens.push({ kind: 'keyword', value: m[4] });
      else tokens.push({ kind: 'function', value: m[4] });
    } else if (m[5]) {
      const word = m[5];
      if (keywords?.has(word)) tokens.push({ kind: 'keyword', value: word });
      else if (builtins?.has(word)) tokens.push({ kind: 'builtin', value: word });
      else tokens.push({ kind: 'plain', value: word });
    } else if (m[6]) tokens.push({ kind: 'punctuation', value: m[6] });
    else if (m[7]) tokens.push({ kind: 'operator', value: m[7] });
    else if (m[0]) tokens.push({ kind: 'plain', value: m[0] });

    last = re.lastIndex;
    // Guard against a zero-width match stalling the loop.
    if (m[0].length === 0) re.lastIndex++;
  }

  if (last < code.length) tokens.push({ kind: 'plain', value: code.slice(last) });
  return tokens;
}
