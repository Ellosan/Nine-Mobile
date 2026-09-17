/**
 * Path helpers for the sandboxed workspace.
 *
 * Every file tool argument is treated as a *relative* path inside the single
 * user-granted working directory. Anything that tries to escape it is rejected
 * here, before it ever reaches the filesystem layer.
 */

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/**
 * Normalise a model-supplied path to a clean relative path.
 * Throws PathError for absolute paths, traversal, or empty input.
 */
export function normalizeRelPath(input: string): string {
  if (typeof input !== 'string') throw new PathError('path must be a string');

  let p = input.trim();
  if (!p) throw new PathError('path must not be empty');

  // Reject anything that is clearly not a workspace-relative path.
  if (p.includes('\0')) throw new PathError('path must not contain null bytes');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) {
    throw new PathError(`path must be relative to the working directory, got a URL: ${input}`);
  }
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) {
    throw new PathError(`absolute paths are not allowed, use a path relative to the working directory: ${input}`);
  }
  if (p.startsWith('~')) throw new PathError('home-relative (~) paths are not allowed');

  p = p.replace(/\\/g, '/');

  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) {
        throw new PathError(`path escapes the working directory: ${input}`);
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }

  if (out.length === 0) throw new PathError(`path resolves to the working directory itself: ${input}`);
  return out.join('/');
}

/** The final path segment. */
export function basename(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] ?? relPath;
}

/** Everything before the final segment ('' when the file is at the root). */
export function dirname(relPath: string): string {
  const parts = relPath.split('/');
  parts.pop();
  return parts.join('/');
}

export function extname(relPath: string): string {
  const base = basename(relPath);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Best-effort MIME type; SAF wants one when creating a document. */
export function mimeTypeFor(relPath: string): string {
  switch (extname(relPath)) {
    case 'txt':
    case 'md':
    case 'markdown':
      return 'text/plain';
    case 'json':
      return 'application/json';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'csv':
      return 'text/csv';
    case 'xml':
      return 'text/xml';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'text/javascript';
    case 'css':
      return 'text/css';
    default:
      // Everything else (ts, tsx, py, rs, go, ...) has no registered type;
      // octet-stream stops SAF from appending a ".txt" extension.
      return 'application/octet-stream';
  }
}
