/**
 * The real tool executor: turns a model tool call into an action against the
 * sandboxed workspace, and turns the outcome back into text the model can read.
 *
 * Everything that can go wrong (bad JSON, path traversal, missing file, no
 * workspace granted, no shell) is reported as an ordinary tool result rather
 * than thrown, so the agent loop can keep going and the model can adapt.
 */

import type { ToolCall } from '../types';
import type { ToolExecutor, ToolResult } from './loop';
import { TOOL_LIST_FILES, TOOL_READ_FILE, TOOL_RUN_SHELL, TOOL_WRITE_FILE } from './toolSchemas';
import {
  listWorkspaceDirectory,
  readWorkspaceFile,
  writeWorkspaceFile,
  MAX_READ_BYTES,
} from '../storage/workspace';
import { runShellCommand } from './termux';
import { PathError } from '../util/path';

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function fail(message: string): ToolResult {
  return { ok: false, content: `ERROR: ${message}` };
}

function parseArgs(call: ToolCall): Record<string, unknown> | null {
  const raw = call.function.arguments?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function describeError(err: unknown): string {
  if (err instanceof PathError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* Individual tools                                                    */
/* ------------------------------------------------------------------ */

async function doReadFile(args: Record<string, unknown>): Promise<ToolResult> {
  const path = asString(args.path);
  if (!path) return fail('read_file requires a "path" string argument.');

  const maxBytesRaw = args.max_bytes;
  const maxBytes =
    typeof maxBytesRaw === 'number' && Number.isFinite(maxBytesRaw)
      ? Math.floor(maxBytesRaw)
      : MAX_READ_BYTES;

  try {
    const res = await readWorkspaceFile(path, maxBytes);
    const header = res.truncated
      ? `${path} (${formatBytes(res.bytes)}, truncated to the first ${formatBytes(res.content.length)})`
      : `${path} (${formatBytes(res.bytes)})`;
    return ok(`${header}\n\n${res.content}`);
  } catch (err) {
    return fail(describeError(err));
  }
}

async function doWriteFile(args: Record<string, unknown>): Promise<ToolResult> {
  const path = asString(args.path);
  if (!path) return fail('write_file requires a "path" string argument.');
  const content = asString(args.content);
  if (content === null) return fail('write_file requires a "content" string argument.');

  try {
    const res = await writeWorkspaceFile(path, content);
    const verb = res.created ? 'Created' : 'Overwrote';
    const renamed =
      res.actualName && res.actualName !== path.split('/').pop()
        ? ` (Android saved it as "${res.actualName}")`
        : '';
    return ok(`${verb} ${res.relPath}${renamed}, ${formatBytes(res.bytes)} written.`);
  } catch (err) {
    return fail(describeError(err));
  }
}

async function doListFiles(args: Record<string, unknown>): Promise<ToolResult> {
  const path = asString(args.path) ?? '.';
  try {
    const entries = await listWorkspaceDirectory(path);
    if (entries.length === 0) return ok(`${path} is empty.`);
    const lines = entries.map((e) =>
      e.isDirectory
        ? `${e.name}/`
        : `${e.name}${typeof e.size === 'number' ? `  (${formatBytes(e.size)})` : ''}`
    );
    return ok(`Contents of ${path}:\n${lines.join('\n')}`);
  } catch (err) {
    return fail(describeError(err));
  }
}

async function doRunShell(args: Record<string, unknown>): Promise<ToolResult> {
  const command = asString(args.command);
  if (!command || !command.trim()) {
    return fail('run_shell_command requires a "command" string argument.');
  }
  const workingDir = asString(args.working_dir);

  const res = await runShellCommand(command, workingDir);

  if (!res.ok && res.exitCode === null) {
    // Unavailable or crashed before running: stderr already explains it.
    return { ok: false, content: res.stderr || 'ERROR: shell execution failed.' };
  }

  const parts: string[] = [`exit code: ${res.exitCode}`];
  if (res.stdout.trim()) parts.push(`stdout:\n${res.stdout}`);
  if (res.stderr.trim()) parts.push(`stderr:\n${res.stderr}`);
  return { ok: res.ok, content: parts.join('\n\n') };
}

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

export function createToolExecutor(): ToolExecutor {
  return {
    async execute(call: ToolCall): Promise<ToolResult> {
      const args = parseArgs(call);
      if (args === null) {
        return fail(
          `could not parse the arguments for ${call.function.name} as JSON. ` +
            `Received: ${call.function.arguments}. Send valid JSON and try again.`
        );
      }

      switch (call.function.name) {
        case TOOL_READ_FILE:
          return doReadFile(args);
        case TOOL_WRITE_FILE:
          return doWriteFile(args);
        case TOOL_LIST_FILES:
          return doListFiles(args);
        case TOOL_RUN_SHELL:
          return doRunShell(args);
        default:
          return fail(
            `unknown tool "${call.function.name}". Available tools: ` +
              `${TOOL_READ_FILE}, ${TOOL_LIST_FILES}, ${TOOL_WRITE_FILE}, ${TOOL_RUN_SHELL}.`
          );
      }
    },
  };
}

/** Human-readable one-liner for a tool call, used by the permission sheet. */
export function describeToolCall(call: ToolCall): { title: string; detail: string } {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    args = {};
  }

  switch (call.function.name) {
    case TOOL_WRITE_FILE: {
      const path = asString(args.path) ?? '(missing path)';
      const content = asString(args.content) ?? '';
      const preview = content.length > 600 ? `${content.slice(0, 600)}\n...` : content;
      return {
        title: `Write ${path}`,
        detail: `${formatBytes(content.length)} will be written to the working directory.\n\n${preview}`,
      };
    }
    case TOOL_RUN_SHELL: {
      const command = asString(args.command) ?? '(missing command)';
      const wd = asString(args.working_dir);
      return {
        title: 'Run shell command',
        detail: wd ? `$ ${command}\n\n(in ${wd})` : `$ ${command}`,
      };
    }
    case TOOL_READ_FILE:
      return { title: `Read ${asString(args.path) ?? ''}`, detail: '' };
    case TOOL_LIST_FILES:
      return { title: `List ${asString(args.path) ?? '.'}`, detail: '' };
    default:
      return { title: call.function.name, detail: call.function.arguments };
  }
}
