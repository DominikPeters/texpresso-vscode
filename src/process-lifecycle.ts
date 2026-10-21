import { ChildProcess, execFile } from 'child_process';

const shutdowns = new WeakMap<ChildProcess, Promise<void>>();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Stop only the process tree owned by this launch, including XeTeX workers. */
export function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) { child.kill(); return Promise.resolve(); }
  const previous = shutdowns.get(child);
  if (previous) { return previous; }
  const shutdown = stop(child);
  shutdowns.set(child, shutdown);
  return shutdown;
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    child.kill(); // Injected processes / a failed spawn have no process group.
    return;
  }
  const pid = child.pid;
  let closed = false;
  const close = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 3000, windowsHide: true }, error => {
        if (error && child.exitCode === null) { child.kill(); }
        resolve();
      });
    });
  } else {
    const signal = (value: NodeJS.Signals | 0) => {
      try { process.kill(-pid, value); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return false; }
        throw error;
      }
    };
    if (!signal('SIGTERM')) { return; }
    const deadline = delay(750);
    await Promise.race([close, deadline]);
    // The launcher may exit while a worker ignores TERM or closes its pipes.
    if (signal(0)) { await deadline; signal('SIGKILL'); }
  }
  if (!closed) { await Promise.race([close, delay(750)]); }
  // Bound shutdown even if a broken launcher leaves inherited pipes open.
  child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  child.unref?.();
}
