/**
 * The keeper — the tiny process `npm start` actually runs. It boots the real
 * server (`server/index.ts`) and does exactly one clever thing: when the
 * server exits with the repot code (87, see `server/update.ts`), it boots a
 * fresh one, which comes up on the just-pulled code. Anything else — a crash,
 * a Ctrl-C — passes straight through, so `npm start` still behaves like the
 * server itself.
 *
 * Nothing else lives here on purpose. This process survives updates while its
 * own file on disk moves ahead, so the code it runs is whatever was current
 * when `npm start` happened. Keep it too small to ever need updating.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTART_EXIT_CODE = 87;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'index.ts');

let child: ChildProcess;
let bootedAt = 0;

function boot(): void {
  bootedAt = Date.now();
  child = spawn(process.execPath, [serverPath], {
    stdio: 'inherit',
    // How the server knows a restart request will actually be honoured.
    env: { ...process.env, TERRARIUM_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART_EXIT_CODE) {
      // A server that asks to be restarted within seconds of booting would
      // spin forever; give the human the terminal back instead.
      if (Date.now() - bootedAt < 5_000) {
        console.error('🪴 The server asked to restart immediately after booting — giving up.');
        process.exit(1);
      }
      console.log('🪴 Repotting: restarting on the updated code…');
      boot();
      return;
    }
    process.exit(signal ? 1 : code ?? 0);
  });
}

// Ctrl-C reaches the child on its own (same process group); these handlers
// only keep the keeper alive long enough to see the child leave.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}

boot();
