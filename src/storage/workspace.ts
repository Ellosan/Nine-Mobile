/**
 * The sandboxed working directory.
 *
 * Android does not give apps arbitrary filesystem access, and AgentKey does not
 * try to get any. The user picks ONE directory through the Storage Access
 * Framework; the OS hands back a scoped tree URI and that is the entire world
 * the file tools can see. Every model-supplied path is normalised to a relative
 * path first (see util/path.ts), so ".." and absolute paths can never escape.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { getSetting, setSetting, deleteSetting } from './db';
import { basename, dirname, mimeTypeFor, normalizeRelPath } from '../util/path';

const SETTING_ROOT_URI = 'workspace.rootUri';

const SAF = FileSystem.StorageAccessFramework;

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspaceEntry {
  name: string;
  uri: string;
  isDirectory: boolean;
  size?: number;
}

/* ------------------------------------------------------------------ */
/* Root management                                                     */
/* ------------------------------------------------------------------ */

let cachedRoot: string | null = null;
let rootLoaded = false;

export async function getWorkspaceRoot(): Promise<string | null> {
  if (rootLoaded) return cachedRoot;
  const stored = await getSetting(SETTING_ROOT_URI);
  cachedRoot = stored;
  rootLoaded = true;
  return stored;
}

export async function setWorkspaceRoot(uri: string | null): Promise<void> {
  cachedRoot = uri;
  rootLoaded = true;
  if (uri) await setSetting(SETTING_ROOT_URI, uri);
  else await deleteSetting(SETTING_ROOT_URI);
}

export function isWorkspaceSupported(): boolean {
  return Platform.OS === 'android';
}

/**
 * Prompt the user to grant a directory. Returns the granted tree URI, or null
 * if they cancelled.
 */
export async function requestWorkspaceDirectory(): Promise<string | null> {
  if (!isWorkspaceSupported()) {
    throw new WorkspaceError('The working directory picker is only available on Android.');
  }
  const res = await SAF.requestDirectoryPermissionsAsync(null);
  if (!res.granted) return null;
  await setWorkspaceRoot(res.directoryUri);
  return res.directoryUri;
}

export async function clearWorkspace(): Promise<void> {
  await setWorkspaceRoot(null);
}

/** A readable label for the granted tree, e.g. "primary:Documents/agent". */
export function workspaceLabel(uri: string | null): string {
  if (!uri) return 'Not set';
  try {
    const decoded = decodeURIComponent(uri);
    const treeIdx = decoded.indexOf('/tree/');
    if (treeIdx >= 0) {
      let id = decoded.slice(treeIdx + '/tree/'.length);
      // A tree URI can carry a trailing /document/<id> section.
      const docIdx = id.indexOf('/document/');
      if (docIdx >= 0) id = id.slice(0, docIdx);
      return id;
    }
    return decoded;
  } catch {
    return uri;
  }
}

async function requireRoot(): Promise<string> {
  const root = await getWorkspaceRoot();
  if (!root) {
    throw new WorkspaceError(
      'No working directory has been granted yet. Open Settings, then "Working directory", and pick a folder.'
    );
  }
  return root;
}

/* ------------------------------------------------------------------ */
/* SAF URI helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Extract the display name from a SAF document URI.
 * `content://.../document/primary%3ADocs%2Fwork%2Fa.ts` becomes `a.ts`.
 */
export function nameFromSafUri(uri: string): string {
  let raw = uri;
  try {
    raw = decodeURIComponent(uri);
  } catch {
    /* keep the raw form */
  }
  // Everything after the last separator of either kind.
  const lastSlash = raw.lastIndexOf('/');
  const lastColon = raw.lastIndexOf(':');
  const cut = Math.max(lastSlash, lastColon);
  return cut >= 0 ? raw.slice(cut + 1) : raw;
}

async function childEntries(dirUri: string): Promise<WorkspaceEntry[]> {
  const uris = await SAF.readDirectoryAsync(dirUri);
  const out: WorkspaceEntry[] = [];
  for (const uri of uris) {
    let isDirectory = false;
    let size: number | undefined;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      isDirectory = Boolean((info as any).isDirectory);
      size = (info as any).size;
    } catch {
      // A child we cannot stat is still worth listing.
    }
    out.push({ name: nameFromSafUri(uri), uri, isDirectory, size });
  }
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** Walk down `segments` from `dirUri`, returning the directory URI or null. */
async function resolveDirectory(dirUri: string, segments: string[]): Promise<string | null> {
  let current = dirUri;
  for (const seg of segments) {
    const entries = await childEntries(current);
    const hit = entries.find((e) => e.name === seg && e.isDirectory);
    if (!hit) return null;
    current = hit.uri;
  }
  return current;
}

/** Walk down `segments` creating any directory that does not exist yet. */
async function resolveOrCreateDirectory(dirUri: string, segments: string[]): Promise<string> {
  let current = dirUri;
  for (const seg of segments) {
    const entries = await childEntries(current);
    const hit = entries.find((e) => e.name === seg && e.isDirectory);
    if (hit) {
      current = hit.uri;
      continue;
    }
    current = await SAF.makeDirectoryAsync(current, seg);
  }
  return current;
}

async function resolveFile(relPath: string): Promise<{ uri: string; parentUri: string } | null> {
  const root = await requireRoot();
  const dir = dirname(relPath);
  const name = basename(relPath);
  const parentUri = dir ? await resolveDirectory(root, dir.split('/')) : root;
  if (!parentUri) return null;
  const entries = await childEntries(parentUri);
  const hit = entries.find((e) => e.name === name && !e.isDirectory);
  return hit ? { uri: hit.uri, parentUri } : null;
}

/* ------------------------------------------------------------------ */
/* Public file operations (all paths are workspace-relative)           */
/* ------------------------------------------------------------------ */

export const MAX_READ_BYTES = 100000;

export interface ReadResult {
  content: string;
  truncated: boolean;
  bytes: number;
}

export async function readWorkspaceFile(
  rawPath: string,
  maxBytes = MAX_READ_BYTES
): Promise<ReadResult> {
  const relPath = normalizeRelPath(rawPath);
  const found = await resolveFile(relPath);
  if (!found) throw new WorkspaceError(`File not found in the working directory: ${relPath}`);

  const content = await SAF.readAsStringAsync(found.uri, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  // A NUL byte in the first chunk means this is almost certainly binary.
  if (content.slice(0, 4096).indexOf(String.fromCharCode(0)) !== -1) {
    throw new WorkspaceError(`${relPath} looks like a binary file; only UTF-8 text can be read.`);
  }

  const cap = Math.max(1, Math.min(maxBytes, MAX_READ_BYTES));
  if (content.length > cap) {
    return { content: content.slice(0, cap), truncated: true, bytes: content.length };
  }
  return { content, truncated: false, bytes: content.length };
}

export interface WriteResult {
  relPath: string;
  /** The name SAF actually used, which can differ from what we asked for. */
  actualName: string;
  bytes: number;
  created: boolean;
}

export async function writeWorkspaceFile(rawPath: string, content: string): Promise<WriteResult> {
  const relPath = normalizeRelPath(rawPath);
  const root = await requireRoot();
  const dir = dirname(relPath);
  const name = basename(relPath);

  const existing = await resolveFile(relPath);
  if (existing) {
    await SAF.writeAsStringAsync(existing.uri, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return { relPath, actualName: name, bytes: content.length, created: false };
  }

  const parentUri = dir ? await resolveOrCreateDirectory(root, dir.split('/')) : root;
  const createdUri = await SAF.createFileAsync(parentUri, name, mimeTypeFor(relPath));
  await SAF.writeAsStringAsync(createdUri, content, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return {
    relPath,
    actualName: nameFromSafUri(createdUri),
    bytes: content.length,
    created: true,
  };
}

export async function listWorkspaceDirectory(rawPath?: string): Promise<WorkspaceEntry[]> {
  const root = await requireRoot();
  const trimmed = (rawPath ?? '').trim();
  if (!trimmed || trimmed === '.' || trimmed === './' || trimmed === '/') {
    return childEntries(root);
  }
  const relPath = normalizeRelPath(trimmed);
  const dirUri = await resolveDirectory(root, relPath.split('/'));
  if (!dirUri) throw new WorkspaceError(`Directory not found in the working directory: ${relPath}`);
  return childEntries(dirUri);
}
