/** A single dark palette. This is a terminal-adjacent tool; it lives in the dark. */

export const colors = {
  bg: '#0B0F14',
  bgElevated: '#121820',
  bgInput: '#0F151D',
  surface: '#161E28',
  border: '#1F2A37',
  borderStrong: '#2C3A4B',

  text: '#E6EDF3',
  textMuted: '#8B98A9',
  textFaint: '#5A6673',

  accent: '#4CA6FF',
  accentDim: '#1D3B5C',

  user: '#1B2C42',
  assistant: '#141B24',

  success: '#3FB950',
  warn: '#D29922',
  danger: '#F85149',

  codeBg: '#0D1117',
  codeBorder: '#21262D',
} as const;

/** Token colours for the code highlighter. */
export const syntaxColors: Record<string, string> = {
  plain: '#C9D1D9',
  comment: '#6E7781',
  string: '#A5D6FF',
  number: '#79C0FF',
  keyword: '#FF7B72',
  builtin: '#FFA657',
  function: '#D2A8FF',
  operator: '#FF7B72',
  punctuation: '#8B949E',
  tag: '#7EE787',
  attr: '#79C0FF',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;

export const fonts = {
  mono: 'monospace',
} as const;
