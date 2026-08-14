import child_process from 'node:child_process';
import fs from 'node:fs';

/**
 * Name of the environment variable through which a judge server tells problem-utils to run
 * untrusted submitted programs as the given unprivileged OS user via sudo.
 *
 * The judge server sets this variable only when it runs the judge harness (e.g. `judge.ts`) as its
 * own trusted user, so that problem files (test cases and the harness itself) stay unreadable to
 * submissions while the submissions themselves run under the sandbox user. When the variable is
 * absent or empty (local development, course authoring, or an all-sandbox judge run), commands run
 * as the current user like before.
 */
export const SANDBOX_USER_ENV_NAME = 'EXERCODE_SANDBOX_USER';

// Absolute path so a submission-controlled `PATH` cannot redirect the privileged `sudo`.
const SUDO_PATH = '/usr/bin/sudo';

export const sandboxUserName = process.env[SANDBOX_USER_ENV_NAME] || undefined;

/**
 * Wrap a command so it runs as the sandbox user. `umask 0` makes every file the sandboxed process
 * creates world-writable, so the harness user can clean it up without privileges. The wrapper also
 * restores `LD_LIBRARY_PATH`, which ld.so strips across the setuid `sudo` exec. Put `timeout`
 * inside the wrapped command: the harness user cannot signal the root-owned `sudo` process, so an
 * outer timer alone could not stop a runaway submission.
 */
export function wrapCommandWithSandboxUser(command: readonly [string, ...string[]]): [string, ...string[]] {
  if (!sandboxUserName) return [...command];
  return [
    SUDO_PATH,
    '--preserve-env',
    '-u',
    sandboxUserName,
    '--',
    'sh',
    '-c',
    'umask 0; if [ -n "$SANDBOX_LD_LIBRARY_PATH" ]; then export LD_LIBRARY_PATH="$SANDBOX_LD_LIBRARY_PATH"; fi; exec "$0" "$@"',
    ...command,
  ];
}

/**
 * Environment overrides for sandboxed processes: a writable home and the `LD_LIBRARY_PATH`
 * smuggled past the setuid `sudo` exec (see {@link wrapCommandWithSandboxUser}).
 */
export function getSandboxUserEnvOverrides(): NodeJS.ProcessEnv {
  if (!sandboxUserName) return {};
  return {
    HOME: `/home/${sandboxUserName}`,
    ...(process.env.LD_LIBRARY_PATH && { SANDBOX_LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH }),
  };
}

/**
 * Make harness-user-created files under the given path readable, and directories writable, for the
 * sandbox user, so sandboxed programs can read their sources and create outputs next to them.
 */
export function makeAccessibleToSandboxUser(targetPath: string): void {
  if (!sandboxUserName) return;
  // Files owned by the sandbox user fail to chmod but are already world-writable (umask 0).
  child_process.spawnSync('chmod', ['-R', 'a+rwX', targetPath]);
}

/**
 * Kill all processes of the sandbox user. The harness user cannot signal another user's processes
 * (nor the root-owned `sudo` wrapper), so this goes through sudo. Killing every sandbox process is
 * safe because the judge server handles one request at a time. SIGTERM is followed by SIGKILL so a
 * submission that traps SIGTERM cannot survive cleanup.
 */
export function killSandboxUserProcesses(): void {
  if (!sandboxUserName) return;
  // Two direct calls instead of one `sh -c 'pkill ...; pkill ...'`: the wrapping shell would run as
  // the sandbox user too, so the first pkill would kill it before the second ran. Each `pkill`
  // exits with 1 when no process matches, so ignore the exit status.
  for (const signal of ['-TERM', '-KILL']) {
    child_process.spawnSync(SUDO_PATH, ['-u', sandboxUserName, 'pkill', signal, '-u', sandboxUserName], {
      // The harness environment must not be passed: sudoers forwards it verbatim, and after sudo
      // drops privileges the helper's `/proc/<pid>/environ` becomes readable by every other
      // sandbox process.
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });
  }
}

/**
 * `fs.rm`-like removal with a fallback for trees holding sandbox-user-owned entries whose
 * permissions block deletion (some tools chmod their outputs regardless of umask): let the sandbox
 * user reopen its own files first, then retry.
 */
export async function forceRemove(targetPath: string): Promise<void> {
  try {
    await fs.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (!sandboxUserName) throw error;
    child_process.spawnSync(SUDO_PATH, ['-u', sandboxUserName, 'chmod', '-R', 'a+rwX', targetPath], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });
    await fs.promises.rm(targetPath, { force: true, recursive: true });
  }
}
