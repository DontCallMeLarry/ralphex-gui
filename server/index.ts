import express from 'express';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { discoverRepos } from './discovery.ts';
import { Freshener } from './freshen.ts';
import { SpecimenStore } from './state.ts';
import { Updater } from './update.ts';
import { createRouter } from './routes.ts';
import { SproutManager } from './sprout.ts';
import { TendManager } from './tend.ts';

const config = loadConfig();
const store = new SpecimenStore(config.stateFile);
const freshener = new Freshener();
const updater = new Updater(config.appRoot);
const sprouts = new SproutManager(config);
const tends = new TendManager(config);
// A fresh id per process: how the page tells "the same server answered again"
// from "the repotted server is up" after an update restart.
const bootId = randomUUID();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', createRouter(config, store, freshener, updater, bootId, sprouts, tends));

// Serve the built frontend from the same server (single command, one port).
const webDist = join(config.appRoot, 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(join(webDist, 'index.html'));
    }
    next();
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('Frontend not built yet. Run: npm run build (then reload this page).');
  });
}

// Error handler: surface problems (e.g. an unreadable state file) instead of hanging.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// Local only (NFR-1): bind to localhost, never to the network. No listen
// callback on purpose: Express 5 fires it on a failed bind too, so the
// 'listening' event is the only trustworthy "we are up".
const server = app.listen(config.port, '127.0.0.1');

server.on('listening', () => {
  const url = `http://localhost:${config.port}`;
  console.log(`🪴 Terrarium ready at ${url}`);
  console.log(`   Scanning: ${config.parentDir} (excluding: ${config.excludeRepos.join(', ')})`);
  if (process.platform === 'darwin' && !process.env.TERRARIUM_NO_OPEN) {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
  // Start fetching immediately: by the time the page renders, the first sync is
  // usually already done, and the browser's own pass joins this one.
  if (config.autoSync) void syncOnStartup();
  // The dashboard keeps itself current the same way: fetch its own origin now
  // (throttled, so the restart after a repot doesn't refetch), then on a
  // timer. Applying is always a human's click — this only looks.
  if (config.autoSync && config.updateCheckHours > 0) {
    void updater.check({ maxAgeMs: 15 * 60_000 });
    updater.schedule(config.updateCheckHours);
  }
});

let waitingForPort = false;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Under the agent, a taken port usually means a terminal copy is still up.
  // Wait for it rather than exiting: launchd doesn't restart a clean exit,
  // and an installed agent that silently stays dead is worse than a log line.
  if (process.env.TERRARIUM_AGENT === '1') {
    if (!waitingForPort) {
      waitingForPort = true;
      console.error(`🪴 Port ${config.port} is taken — waiting for it (retrying every 15s).`);
    }
    setTimeout(() => server.listen(config.port, '127.0.0.1'), 15_000);
    return;
  }
  // Exit 0 on purpose: "someone is already doing my job" is not a failure.
  console.error(
    `🪴 Port ${config.port} is already taken — Terrarium is probably running already` +
      ` (npm run agent:status knows). Stop that one, or change "port" in terrarium.config.json.`,
  );
  process.exit(0);
});

// Closing a terminal window does not reliably signal child processes on
// macOS — a dashboard started with `npm start` can outlive its window and
// keep the port, invisibly. But the dying pty ends stdin, and that is
// audible: when stdin is a TTY and it ends, the terminal is gone, so leave
// with it. The background agent has no TTY and is exempt.
if (process.stdin.isTTY) {
  const terminalGone = () => {
    stopEverything();
    server.close();
    process.exit(0);
  };
  process.stdin.on('end', terminalGone);
  process.stdin.on('error', terminalGone);
  process.stdin.resume();
}

async function syncOnStartup(): Promise<void> {
  try {
    const repos = await discoverRepos(config.parentDir, config.excludeRepos, config.excludeWorktreePatterns);
    for (const sync of await freshener.syncAll(repos, { maxAgeMs: config.autoSyncMinutes * 60_000 })) {
      if (sync.problem) console.log(`   ⚠ ${sync.repo}: ${sync.problem}`);
      else if (sync.advancedBy > 0) {
        console.log(`   ↻ ${sync.repo}: ${sync.defaultBranch} fast-forwarded ${sync.advancedBy} commits`);
      }
    }
  } catch (err) {
    console.error(`   ⚠ sync failed: ${(err as Error).message}`);
  }
}

/**
 * ralphex runs in a process group of its own, so that stopping one reaches the
 * claude processes it spawned. The cost of that is that Ctrl-C here does *not*
 * reach it: a run left behind would go on committing into a worktree with
 * nobody watching. So leaving takes them with us.
 */
function stopEverything(): void {
  const live = tends.live();
  if (live.length) console.log(`🪴 Stopping ${live.length} run${live.length === 1 ? '' : 's'} first…`);
  for (const tend of live) tend.session.cancel();
}

process.on('SIGINT', () => {
  stopEverything();
  server.close();
  process.exit(0);
});
