import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 * - The harness process environment is forwarded to sandboxed submissions (sudo runs with
 *   `--preserve-env`), so it must not contain secrets beyond what submissions may see. The one
 *   exception is the set glibc strips when executing the setuid `sudo` (secure-execution mode:
 *   `LD_*`, `TMPDIR`, `LOCPATH`, `NLSPATH`, `TZDIR`, … — see ld.so(8)); no sudoers setting can
 *   recover those, and only `LD_LIBRARY_PATH` is restored, by the wrapper below.
 * - sudoers must let the harness user run arbitrary commands as the sandbox user without a
 *   password, pass the environment through, and keep sudo off a pseudo-terminal (a pty would merge
 *   stderr into stdout and CRLF-mangle output when the harness happens to run from a terminal):
 *   e.g. `Defaults:<harness> !env_reset, !env_delete, !env_check, !secure_path, !use_pty` plus
 *   `<harness> ALL=(<sandbox>) NOPASSWD:SETENV: ALL`.
 * - Variables meant for the submitted program rather than for the harness must be passed under
 *   {@link SANDBOX_ENV_PREFIX}; problem-utils strips that prefix when it builds a submission's
 *   environment.
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

/**
 * Environment for helper processes the *trusted* harness user runs (`ps`, `xwininfo`, `Xvfb`, …).
 * The judge server overlays caller-supplied variables onto the harness environment, and a sandboxed
 * submission can create executables in its persistent home, so resolving these helpers through the
 * inherited `PATH` would hand the submission code execution as the harness user. Node resolves the
 * command through the child environment's `PATH`, so a fixed `PATH` here pins them to system paths.
 */
export function getTrustedHelperEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Without delegation the submission runs as this same user, so there is no boundary to defend and
  // pinning `PATH` would only break setups whose X11/`ps` binaries live elsewhere (e.g. /usr/games,
  // /snap/bin, Nix). Keep the inherited environment there, exactly as before delegation existed.
  if (!sandboxUserName) return { ...process.env, ...extraEnv };
  return { ...MINIMAL_ENV, ...extraEnv };
}

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
  // Idempotent; see {@link isSandboxWrappedCommand}.
  if (isSandboxWrappedCommand(command)) return [...command];
  return [...buildSandboxWrapperPrefix(sandboxUserName), ...command];
}

const SANDBOX_WRAPPER_SCRIPT =
  'umask 0; if [ -n "$SANDBOX_LD_LIBRARY_PATH" ]; then export LD_LIBRARY_PATH="$SANDBOX_LD_LIBRARY_PATH"; fi; exec "$0" "$@"';

function buildSandboxWrapperPrefix(user: string): [string, ...string[]] {
  return [SUDO_PATH, '--preserve-env', '-u', user, '--', 'sh', '-c', SANDBOX_WRAPPER_SCRIPT];
}

/**
 * Whether the command was already wrapped by {@link wrapCommandWithSandboxUser}. The presets hand
 * custom runners a wrapped command, and a runner may forward it to another helper that wraps too;
 * a nested wrapper's inner `sudo` would run AS the sandbox user, which sudoers does not authorize,
 * so every test case of such a problem would fail only under delegation.
 *
 * Matches the wrapper prefix exactly rather than looking for `sudo` anywhere: a submission-derived
 * command could otherwise carry a literal `/usr/bin/sudo` argument and skip wrapping entirely,
 * which would run the submission as the trusted harness user.
 */
export function isSandboxWrappedCommand(command: readonly string[]): boolean {
  if (!sandboxUserName) return false;
  const prefix = buildSandboxWrapperPrefix(sandboxUserName);
  return prefix.every((argument, index) => command[index] === argument);
}

/**
 * Insert `innerPrefix` (e.g. a `time` measurement prefix) so that it runs INSIDE the sandbox
 * wrapper when `command` is wrapped, and simply in front otherwise. Prefixing a wrapped command
 * from the outside would run `innerPrefix` as the trusted harness user while its arguments (such
 * as an output path) point into a sandbox-writable directory, where a submission can plant a
 * symlink and have the harness truncate an arbitrary file it owns.
 */
export function prependInsideSandboxWrapper(
  command: readonly [string, ...string[]],
  innerPrefix: readonly string[]
): [string, ...string[]] {
  if (!isSandboxWrappedCommand(command)) return [...innerPrefix, ...command] as [string, ...string[]];
  const prefixLength = buildSandboxWrapperPrefix(sandboxUserName as string).length;
  return [...command.slice(0, prefixLength), ...innerPrefix, ...command.slice(prefixLength)] as [string, ...string[]];
}

/**
 * Environment overrides for sandboxed processes: a writable home and the `LD_LIBRARY_PATH`
 * smuggled past the setuid `sudo` exec (see {@link wrapCommandWithSandboxUser}). Pass the
 * environment the command will actually run with so a caller-supplied `LD_LIBRARY_PATH` survives
 * the exec; the harness's own value is only the fallback.
 */
export function getSandboxUserEnvOverrides(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!sandboxUserName) return {};
  const sourceEnv = env ?? process.env;
  const submissionOnlyEnv = unwrapSubmissionOnlyEnv(sourceEnv);
  // A submission-only `LD_LIBRARY_PATH` must be the one smuggled past the exec, not the harness's.
  const ldLibraryPath = submissionOnlyEnv.LD_LIBRARY_PATH ?? sourceEnv.LD_LIBRARY_PATH ?? process.env.LD_LIBRARY_PATH;
  return {
    HOME: `/home/${sandboxUserName}`,
    ...submissionOnlyEnv,
    // Last: the wrapper reads this one, so a caller must not be able to overwrite it.
    ...(ldLibraryPath && { SANDBOX_LD_LIBRARY_PATH: ldLibraryPath }),
  };
}

/**
 * Prefix under which a delegating judge server passes variables that belong to the submitted
 * program alone. Applying a request's variables to the harness itself would let a submission point
 * e.g. `PATH` or `NODE_OPTIONS` at its own files and get code executed as the trusted harness user,
 * so the server prefixes them and problem-utils strips the prefix back off here, where the
 * environment of a sandboxed submission is built.
 */
export const SANDBOX_ENV_PREFIX = 'SANDBOX_ENV_';

function unwrapSubmissionOnlyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const unwrapped: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(SANDBOX_ENV_PREFIX)) continue;
    const unwrappedName = name.slice(SANDBOX_ENV_PREFIX.length);
    if (unwrappedName) unwrapped[unwrappedName] = value;
  }
  return unwrapped;
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
    const result = runAsSandboxUser(['pkill', `-${signal}`, '-u', sandboxUserName]);
    // Fail closed: a submission can exhaust the PID cgroup so this `sudo` cannot even be spawned.
    // Reporting success would leave its processes alive for the next request on this instance.
    if (result.error) {
      throw new Error(`failed to terminate ${sandboxUserName} processes: ${result.error.message}`);
    }
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
 * How long after a command's own deadline {@link startSandboxTimeoutWatchdog} force-kills the
 * sandbox user. Callers waiting for the watchdog to end a submission must wait at least this long.
 */
export const SANDBOX_WATCHDOG_GRACE_SECONDS = 5;

/** Cancels a {@link startSandboxTimeoutWatchdog}; `fired` reports whether its deadline elapsed. */
export interface SandboxTimeoutWatchdog {
  cancel(): void;
  fired(): boolean;
}

/**
 * Start a harness-owned watchdog that force-kills every sandbox process after the given deadline.
 * A sandboxed submission can signal its own `timeout` supervisor (same UID), and a synchronous
 * spawn blocks the harness's event loop, so without this external deadline a submission could run
 * until the outer judge-server limit. The watchdog's `sh`/`sleep` run as the harness user, out of
 * the submission's reach; killing the watchdog's process group cancels it before it spawns sudo.
 *
 * ALWAYS cancel in a `finally`: the watchdog is detached and `unref`'d, so a leaked one keeps
 * running after the harness exits and would SIGKILL a later request's submission.
 */
export function startSandboxTimeoutWatchdog(timeoutSeconds: number): SandboxTimeoutWatchdog {
  if (!sandboxUserName) return { cancel: () => {}, fired: () => false };

  const deadlineSeconds = Math.ceil(timeoutSeconds) + SANDBOX_WATCHDOG_GRACE_SECONDS;
  const watchdog = child_process.spawn(
    '/bin/sh',
    ['-c', `${SLEEP_PATH} ${deadlineSeconds}; ${SUDO_PATH} -u "$1" pkill -KILL -u "$1"`, 'sh', sandboxUserName],
    { detached: true, stdio: 'ignore', env: MINIMAL_ENV }
  );
  // Without a listener, a spawn failure (e.g. the submission exhausted the PID cgroup) would be an
  // unhandled 'error' event that terminates the harness. Fail closed instead: callers check
  // `fired()`, and a watchdog that never started reports its deadline as elapsed.
  let spawnFailed = false;
  watchdog.on('error', () => {
    spawnFailed = true;
  });
  let exited = false;
  watchdog.on('exit', () => {
    exited = true;
  });
  watchdog.unref();

  const startTimeMilliseconds = Date.now();
  let cancelled = false;
  return {
    cancel: () => {
      cancelled = true;
      if (watchdog.pid === undefined || exited) return;
      try {
        process.kill(-watchdog.pid, 'SIGKILL');
      } catch {
        // The watchdog already fired and exited.
      }
    },
    // The `exit`/`error` events cannot be observed from a synchronous caller (they need the event
    // loop), so decide by elapsed time, which is what the watchdog itself waits on.
    fired: () =>
      spawnFailed ||
      watchdog.pid === undefined ||
      (!cancelled && Date.now() - startTimeMilliseconds >= deadlineSeconds * 1000),
  };
}

/**
 * Run a helper as the sandbox user with a minimal environment. The harness environment must not be
 * passed: sudoers forwards it verbatim, and after sudo drops privileges the helper's
 * `/proc/<pid>/environ` becomes readable by every other sandbox process.
 */
function runAsSandboxUser(command: [string, ...string[]]): child_process.SpawnSyncReturns<Buffer> {
  return child_process.spawnSync(SUDO_PATH, ['-u', sandboxUserName as string, ...command], { env: MINIMAL_ENV });
}

/**
 * `fs.rm`-like removal with a fallback for trees holding sandbox-user-owned entries whose
 * permissions block deletion: let the sandbox user reopen its own files first, then retry. The
 * containing directory is relaxed as well — unlinking an entry needs write permission on its
 * parent, so a submission that chmods a directory it owns would otherwise make everything inside it
 * undeletable.
 */
export async function forceRemove(targetPath: string): Promise<void> {
  try {
    await fs.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (!sandboxUserName) throw error;
    relaxPermissionsAsSandboxUser(targetPath);
    // Not recursive: only the containing directory's own write bit governs the unlink.
    runAsSandboxUser(['chmod', 'a+rwX', path.dirname(targetPath)]);
    await fs.promises.rm(targetPath, { force: true, recursive: true });
  }
}
