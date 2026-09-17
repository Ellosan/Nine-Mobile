/**
 * Shell execution bridge.
 *
 * ## Why this file is mostly a polite refusal
 *
 * Android sandboxes every app. AgentKey cannot spawn `/bin/sh` inside another
 * app's sandbox, and it will not try to: no reflection tricks, no exec of a
 * bundled busybox into shared storage, no root. The only sanctioned way for one
 * Android app to run a shell command in another is for the *other* app to
 * expose an entry point, and Termux does: `com.termux.RUN_COMMAND`.
 *
 * The catch is that `RUN_COMMAND` is delivered to `RunCommandService`, a
 * *service*. Managed Expo only exposes `startActivityAsync` through
 * `expo-intent-launcher`, and you cannot start a service with it. So on a plain
 * Expo/EAS build, run_shell_command is DISABLED and reports itself as
 * unavailable to the model (which is exactly what the model needs to hear so it
 * stops retrying and solves the task with the file tools instead).
 *
 * To actually enable it you need a dev/prebuild with a small native module that
 * calls `startForegroundService()` with the RUN_COMMAND intent, plus the
 * `com.termux.permission.RUN_COMMAND` permission and Termux's
 * `allow-external-apps=true` property. If such a module is installed it will
 * appear on `NativeModules.AgentKeyTermux` and this file will use it. See the
 * "Shell access" section of the README for the full recipe.
 */

import { NativeModules, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

export const TERMUX_PACKAGE = 'com.termux';
export const TERMUX_API_PACKAGE = 'com.termux.api';
export const TERMUX_RUN_COMMAND_ACTION = 'com.termux.RUN_COMMAND';

export type ShellAvailability =
  | { available: true; via: 'native-module' }
  | { available: false; reason: string; termuxInstalled: boolean };

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** The optional native bridge described in the file header. */
interface AgentKeyTermuxModule {
  runCommand(
    command: string,
    args: string[],
    workdir: string | null
  ): Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
}

function nativeBridge(): AgentKeyTermuxModule | null {
  const mod = (NativeModules as Record<string, unknown>).AgentKeyTermux;
  if (mod && typeof (mod as AgentKeyTermuxModule).runCommand === 'function') {
    return mod as AgentKeyTermuxModule;
  }
  return null;
}

/**
 * Best-effort check for whether Termux is installed.
 *
 * `getApplicationIconAsync` returns an empty string for a package that is not
 * installed (or not visible under Android 11+ package visibility, which is why
 * app.json declares a `queries` entry for com.termux).
 */
export async function isTermuxInstalled(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const icon = await IntentLauncher.getApplicationIconAsync(TERMUX_PACKAGE);
    return typeof icon === 'string' && icon.length > 'data:image/png;base64,'.length;
  } catch {
    return false;
  }
}

export async function getShellAvailability(): Promise<ShellAvailability> {
  if (Platform.OS !== 'android') {
    return {
      available: false,
      termuxInstalled: false,
      reason: 'Shell execution is only wired up for Android.',
    };
  }

  const termuxInstalled = await isTermuxInstalled();

  if (nativeBridge()) return { available: true, via: 'native-module' };

  if (!termuxInstalled) {
    return {
      available: false,
      termuxInstalled: false,
      reason:
        'Termux is not installed. Shell execution is disabled. Install Termux (F-Droid or GitHub, ' +
        'not the abandoned Play Store build) and add the AgentKey Termux native module to a dev build ' +
        'to enable it.',
    };
  }

  return {
    available: false,
    termuxInstalled: true,
    reason:
      'Termux is installed, but this build cannot reach it. Termux receives com.termux.RUN_COMMAND ' +
      'as a foreground *service*, and managed Expo can only start activities. Rebuild with the ' +
      'AgentKey Termux native module (see README, "Shell access") to enable shell execution.',
  };
}

/** Opens the Termux app, which is all a managed build can do. */
export async function openTermux(): Promise<void> {
  IntentLauncher.openApplication(TERMUX_PACKAGE);
}

/**
 * Split a command line into the executable plus arguments, honouring single and
 * double quotes. Termux's RUN_COMMAND wants them separately.
 */
export function splitCommand(commandLine: string): { executable: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasCurrent = false;

  for (let i = 0; i < commandLine.length; i++) {
    const c = commandLine[i];
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      hasCurrent = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (hasCurrent || current.length > 0) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += c;
    hasCurrent = true;
  }
  if (hasCurrent || current.length > 0) tokens.push(current);

  if (tokens.length === 0) return { executable: '', args: [] };
  return { executable: tokens[0] as string, args: tokens.slice(1) };
}

/**
 * Run a command, if and only if the native Termux bridge is present.
 * Otherwise returns a clear, non-throwing "unavailable" result.
 */
export async function runShellCommand(
  commandLine: string,
  workdir?: string | null
): Promise<ShellResult> {
  const bridge = nativeBridge();
  if (!bridge) {
    const availability = await getShellAvailability();
    const reason = availability.available ? 'Shell bridge disappeared.' : availability.reason;
    return { ok: false, stdout: '', stderr: `UNAVAILABLE: ${reason}`, exitCode: null };
  }

  const { executable, args } = splitCommand(commandLine);
  if (!executable) {
    return { ok: false, stdout: '', stderr: 'UNAVAILABLE: empty command.', exitCode: null };
  }

  try {
    const res = await bridge.runCommand(executable, args, workdir ?? null);
    const exitCode = typeof res.exitCode === 'number' ? res.exitCode : 0;
    return {
      ok: exitCode === 0,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      exitCode,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: null,
    };
  }
}
