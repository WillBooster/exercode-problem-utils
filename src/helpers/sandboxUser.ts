import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Name of the environment variable through which a judge server tells problem-utils to run
 * untrusted submitted programs as the given unprivileged OS user via sudo.
 *
 * The judge server sets this variable only when it runs the judge harness (e.g. `judge.ts`) as its
 * own trusted user, so that problem files (test cases and the harness itself) stay unreadable to
 * submissions while the submissions themselves run under the sandbox user. When the variable is
 * absent or empty (local development, course authoring, or an all-sandbox judge run), commands run
 * as the current user like before.
 *
 * Contract for the delegating judge server (delegation is Linux-only — sudo user separation and
 * `/home/<user>` homes are provisioned in the judge Docker image; never set this on macOS):
 * - The harness process environment is forwarded verbatim to sandboxed submissions (sudo runs with
 *   `--preserve-env`), so it must not contain secrets beyond what submissions may see.
 * - sudoers must let the harness user run arbitrary commands as the sandbox user without a
 *   password, pass the environment through, and keep sudo off a pseudo-terminal (a pty would merge
 *   stderr into stdout and CRLF-mangle output when the harness happens to run from a terminal):
 *   e.g. `Defaults:<harness> !env_reset, !env_delete, !env_check, !secure_path, !use_pty` plus
 *   `<harness> ALL=(<sandbox>) NOPASSWD:SETENV: ALL`.
 * - The sandbox user's home directory must exist at `/home/<sandbox user>` and be writable. It is
 *   shared across sequential requests, so the server is responsible for resetting whatever
 *   cross-request persistence there matters to it.
 */
export const SANDBOX_USER_ENV_NAME = 'EXERCODE_SANDBOX_USER';

// Absolute paths so a submission-influenced `PATH` cannot redirect binaries that the trusted
// harness user executes (`sudo` is also setuid and must be the real one).
const SUDO_PATH = '/usr/bin/sudo';
const CHMOD_PATH = '/bin/chmod';
const SLEEP_PATH = '/bin/sleep';
// Minimal environment for trusted helper processes; never forward the harness environment to them.
const MINIMAL_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin' } as const;

export const sandboxUserName = process.env[SANDBOX_USER_ENV_NAME] || undefined;

// Fail fast on the catastrophic misconfiguration where the sandbox user is the harness's own user:
// cleanup (`killSandboxUserProcesses`) would then SIGKILL the harness itself on the first run.
if (sandboxUserName && sandboxUserName === os.userInfo().username) {
  throw new Error(
    `${SANDBOX_USER_ENV_NAME} must name a different OS user than the one running the harness (got "${sandboxUserName}"). Leave it unset to run everything as the current user.`
  );
}

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
 * smuggled past the setuid `sudo` exec (see {@link wrapCommandWithSandboxUser}). Pass the
 * environment the command will actually run with so a caller-supplied `LD_LIBRARY_PATH` survives
 * the exec; the harness's own value is only the fallback.
 */
export function getSandboxUserEnvOverrides(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!sandboxUserName) return {};
  const ldLibraryPath = env?.LD_LIBRARY_PATH ?? process.env.LD_LIBRARY_PATH;
  return {
    HOME: `/home/${sandboxUserName}`,
    ...(ldLibraryPath && { SANDBOX_LD_LIBRARY_PATH: ldLibraryPath }),
  };
}

/**
 * Make harness-user-created files under the given path readable, and directories writable, for the
 * sandbox user, so sandboxed programs can read their sources and create outputs next to them.
 */
export function makeAccessibleToSandboxUser(targetPath: string): void {
  if (!sandboxUserName) return;
  // Files owned by the sandbox user fail to chmod but are already world-writable (umask 0).
  child_process.spawnSync(CHMOD_PATH, ['-R', 'a+rwX', targetPath], { env: MINIMAL_ENV });
}

/**
 * Kill the sandbox user's processes with the given signals. The harness user cannot signal another
 * user's processes (nor the root-owned `sudo` wrapper), so this goes through sudo. Killing every
 * sandbox process is safe because the judge server handles one request at a time. The default
 * sends SIGTERM immediately followed by SIGKILL (final cleanup); callers that want a grace period
 * send `['TERM']`, wait, and then send `['KILL']`.
 */
export function killSandboxUserProcesses(signals: readonly ('TERM' | 'KILL')[] = ['TERM', 'KILL']): void {
  if (!sandboxUserName) return;
  // One direct call per signal instead of one `sh -c 'pkill ...; pkill ...'`: the wrapping shell
  // would run as the sandbox user too, so the first pkill would kill it before the second ran.
  // Each `pkill` exits with 1 when no process matches, so ignore the exit status.
  for (const signal of signals) {
    runAsSandboxUser(['pkill', `-${signal}`, '-u', sandboxUserName]);
  }
}

/**
 * Let the sandbox user reopen the permissions of its own files under the given path, for
 * harness-side traversal/cleanup of trees where a sandboxed process restricted permissions
 * (some tools chmod their outputs regardless of umask).
 */
export function relaxPermissionsAsSandboxUser(targetPath: string): void {
  if (!sandboxUserName) return;
  runAsSandboxUser(['chmod', '-R', 'a+rwX', targetPath]);
}

/**
 * Start a harness-owned watchdog that force-kills every sandbox process after the given deadline,
 * and return a function that cancels it. A sandboxed submission can signal its own `timeout`
 * supervisor (same UID), and a synchronous spawn blocks the harness's event loop, so without this
 * external deadline a submission could run until the outer judge-server limit. The watchdog's
 * `sh`/`sleep` run as the harness user, out of the submission's reach; killing the watchdog's
 * process group cancels it before it spawns sudo.
 */
export function startSandboxTimeoutWatchdog(timeoutSeconds: number): () => void {
  if (!sandboxUserName) return () => {};
  const deadlineSeconds = Math.ceil(timeoutSeconds) + 5;
  const watchdog = child_process.spawn(
    '/bin/sh',
    ['-c', `${SLEEP_PATH} ${deadlineSeconds}; ${SUDO_PATH} -u "$1" pkill -KILL -u "$1"`, 'sh', sandboxUserName],
    { detached: true, stdio: 'ignore', env: MINIMAL_ENV }
  );
  watchdog.unref();
  return () => {
    if (watchdog.pid === undefined) return;
    try {
      process.kill(-watchdog.pid, 'SIGKILL');
    } catch {
      // The watchdog already fired and exited.
    }
  };
}

/**
 * Run a helper as the sandbox user with a minimal environment. The harness environment must not be
 * passed: sudoers forwards it verbatim, and after sudo drops privileges the helper's
 * `/proc/<pid>/environ` becomes readable by every other sandbox process.
 */
function runAsSandboxUser(command: [string, ...string[]]): void {
  child_process.spawnSync(SUDO_PATH, ['-u', sandboxUserName as string, ...command], { env: MINIMAL_ENV });
}

/**
 * `fs.rm`-like removal with a fallback for trees holding sandbox-user-owned entries whose
 * permissions block deletion: let the sandbox user reopen its own files first, then retry.
 */
export async function forceRemove(targetPath: string): Promise<void> {
  try {
    await fs.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (!sandboxUserName) throw error;
    relaxPermissionsAsSandboxUser(targetPath);
    await fs.promises.rm(targetPath, { force: true, recursive: true });
  }
}
