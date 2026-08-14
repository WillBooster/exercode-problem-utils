import { killSandboxUserProcesses, sandboxUserName } from './sandboxUser.js';

/**
 * Run a problem-supplied `runCommand` handler, then terminate every sandbox-user process it left
 * behind. A submission can daemonize and close its inherited streams so the handler returns while
 * its child keeps running; that child could otherwise modify the working directory while the
 * harness reads outputs, or survive into the next test case or request. The built-in run paths
 * sweep the same way in their own `finally`.
 */
export async function runCustomRunner<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } finally {
    if (sandboxUserName) killSandboxUserProcesses();
  }
}
