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
    const signal = async (value: NodeJS.Signals | 0) => {
      try { process.kill(-pid, value); return true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') { return false; }
        if (code === 'EPERM' && process.platform === 'darwin') {
          // macOS can deny group signaling after the last live task exits.
          // Confirm that only zombies/no members remain; a denied signal to
          // any live worker is still an error, never a successful shutdown.
          const alive = await new Promise<boolean>((resolve, reject) => {
            execFile('ps', ['-axo', 'pgid=,stat='], { timeout: 2000 }, (psError, output) => {
              const rows = output.trim().split('\n').filter(Boolean);
              if (psError || !rows.length || rows.some(row => !/^\s*\d+\s+\S+\s*$/.test(row))) { reject(error); return; }
              resolve(rows.some(row => {
                const [group, state] = row.trim().split(/\s+/);
                return Number(group) === pid && !state.startsWith('Z');
              }));
            });
          });
          if (!alive) { return false; }
        }
        throw error;
      }
    };
    if (!await signal('SIGTERM')) { return; }
    const deadline = delay(750);
    await Promise.race([close, deadline]);
    // The launcher may exit while a worker ignores TERM or closes its pipes.
    if (await signal(0)) { await deadline; await signal('SIGKILL'); }
  }
  if (!closed) { await Promise.race([close, delay(750)]); }
  // Bound shutdown even if a broken launcher leaves inherited pipes open.
  child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  child.unref?.();
}
