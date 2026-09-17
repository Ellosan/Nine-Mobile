/**
 * Tool definitions advertised to the model.
 *
 * Keep the descriptions blunt about the sandbox: the model behaves much better
 * when it knows up-front that paths are workspace-relative and that shell
 * access may simply not exist on this device.
 */

import type { ToolSchema } from '../types';

export const TOOL_READ_FILE = 'read_file';
export const TOOL_WRITE_FILE = 'write_file';
export const TOOL_LIST_FILES = 'list_files';
export const TOOL_RUN_SHELL = 'run_shell_command';

/** Tools that must never run without an explicit user tap. */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([TOOL_WRITE_FILE, TOOL_RUN_SHELL]);

export function isDestructive(toolName: string): boolean {
  return DESTRUCTIVE_TOOLS.has(toolName);
}

export const readFileSchema: ToolSchema = {
  type: 'function',
  function: {
    name: TOOL_READ_FILE,
    description:
      'Read a UTF-8 text file from the working directory. Paths are always relative to the ' +
      'working directory the user granted; absolute paths and ".." are rejected.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the working directory, e.g. "src/index.ts".',
        },
        max_bytes: {
          type: 'integer',
          description: 'Optional cap on how many bytes to return (default 100000).',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

export const writeFileSchema: ToolSchema = {
  type: 'function',
  function: {
    name: TOOL_WRITE_FILE,
    description:
      'Create or overwrite a UTF-8 text file in the working directory. Requires explicit user ' +
      'approval on every call. Paths are relative to the working directory.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the working directory, e.g. "notes/todo.md".',
        },
        content: { type: 'string', description: 'Full new contents of the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
};

export const listFilesSchema: ToolSchema = {
  type: 'function',
  function: {
    name: TOOL_LIST_FILES,
    description:
      'List the files and folders inside a directory of the working directory. Use this to ' +
      'discover what exists before reading or writing.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory relative to the working directory. Omit or "." for the root.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const runShellSchema: ToolSchema = {
  type: 'function',
  function: {
    name: TOOL_RUN_SHELL,
    description:
      'Run a shell command. IMPORTANT: Android sandboxes every app, so this only works when the ' +
      'Termux companion integration is installed and enabled; otherwise the call returns an ' +
      '"unavailable" error and you should solve the task another way. Requires explicit user ' +
      'approval on every call.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
        working_dir: {
          type: 'string',
          description: 'Optional directory relative to the working directory to run in.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

export const ALL_TOOLS: ToolSchema[] = [
  readFileSchema,
  listFilesSchema,
  writeFileSchema,
  runShellSchema,
];

/** The tool list for a given configuration. */
export function toolsFor(opts: { fileTools: boolean; shellTool: boolean }): ToolSchema[] {
  const tools: ToolSchema[] = [];
  if (opts.fileTools) tools.push(readFileSchema, listFilesSchema, writeFileSchema);
  if (opts.shellTool) tools.push(runShellSchema);
  return tools;
}

export const DEFAULT_SYSTEM_PROMPT = `You are AgentKey, a coding agent running on an Android phone.

Environment:
- You act through tools on a single working directory the user explicitly granted. Every path you
  pass to a tool is relative to that directory. Absolute paths and ".." will be rejected.
- Android sandboxes apps, so shell access is often unavailable. If run_shell_command reports that
  it is unavailable, do not keep retrying it -- accomplish the task with the file tools instead.
- write_file and run_shell_command require the user to approve each call. If a call is denied,
  acknowledge it and propose an alternative rather than immediately trying again.

Style:
- Be concise. The screen is small.
- Use fenced code blocks with a language tag for code.
- Prefer reading a file before rewriting it, so you do not destroy content you have not seen.`;
