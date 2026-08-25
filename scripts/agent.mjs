#!/usr/bin/env node
/**
 * The background agent: launchd running the same keeper `npm start` runs, so
 * Terrarium is simply *there* — starts at login, needs no terminal window,
 * comes back after a crash, and the repot restart works exactly as it does in
 * a terminal. Opt-in, and plain `npm start` keeps working either way.
 *
 *   npm run agent:install     # write the plist and start it now + at login
 *   npm run agent:status      # is it loaded / running?
 *   npm run agent:uninstall   # stop it and remove the plist
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.terrarium.dashboard';
const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;
const logPath = join(appRoot, 'data', 'agent.log');

if (process.platform !== 'darwin') {
  console.error(
    'The background agent uses launchd, so it is macOS-only.\n' +
      'On other systems keep `npm start` running in a terminal (or wire up your own service).',
  );
  process.exit(1);
}

let port = 7855;
try {
  port = JSON.parse(readFileSync(join(appRoot, 'terrarium.config.json'), 'utf8')).port ?? 7855;
} catch {
  // no config file — the default port applies
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(join(appRoot, 'server', 'main.ts'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(appRoot)}</string>
  <key>RunAtLoad</key><true/>
  <!-- Relaunch after a crash; a clean exit (Ctrl-C equivalent) stays down. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd knows no shell PATH; hand it the one this install ran with,
         so git, npm and glab resolve exactly as they do in a terminal. -->
    <key>PATH</key><string>${esc(process.env.PATH ?? '/usr/bin:/bin')}</string>
    <!-- An agent that opened a browser tab at every login would not last. -->
    <key>TERRARIUM_NO_OPEN</key><string>1</string>
    <!-- Tells the server to wait for a taken port instead of exiting. -->
    <key>TERRARIUM_AGENT</key><string>1</string>
  </dict>
</dict>
</plist>
`;

const launchctl = (args) =>
  execFileSync('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const bootout = () => {
  try {
    launchctl(['bootout', `${domain}/${LABEL}`]);
  } catch {
    // not loaded — fine
  }
};

const command = process.argv[2];

if (command === 'install') {
  mkdirSync(join(appRoot, 'data'), { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });
  bootout();
  writeFileSync(plistPath, plist);
  launchctl(['bootstrap', domain, plistPath]);
  console.log('🪴 Terrarium now runs in the background and starts at every login.');
  console.log(`   Dashboard: http://localhost:${port}`);
  console.log(`   Logs:      ${logPath}`);
  console.log('   Stop it:   npm run agent:uninstall');
  console.log('   (If a terminal copy holds the port, the agent waits and takes over when it stops.)');
} else if (command === 'uninstall') {
  bootout();
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log('🪴 Background agent removed. `npm start` in a terminal works as always.');
} else if (command === 'status') {
  if (!existsSync(plistPath)) {
    console.log('Not installed. `npm run agent:install` sets it up.');
  } else {
    try {
      const out = launchctl(['print', `${domain}/${LABEL}`]);
      const pid = out.match(/^\s*pid = (\d+)/m)?.[1];
      const state = out.match(/^\s*state = (\w+)/m)?.[1] ?? 'unknown';
      console.log(pid ? `Running (pid ${pid}) — http://localhost:${port}` : `Installed, ${state}.`);
    } catch {
      console.log('Installed but not loaded — run `npm run agent:install` again to start it.');
    }
  }
} else {
  console.error('Usage: node scripts/agent.mjs <install|uninstall|status>');
  process.exit(1);
}
