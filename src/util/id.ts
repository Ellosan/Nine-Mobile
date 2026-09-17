/** Small, dependency-free id helpers. */

export function uid(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}${t}${r}`;
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
