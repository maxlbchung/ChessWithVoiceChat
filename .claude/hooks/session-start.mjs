#!/usr/bin/env node
// SessionStart hook — injects repo state into the agent's context at session start.
// Guards against the two recurring traps in this repo: a parallel Claude session
// having uncommitted work in the tree, and the dev-server port not being 5173.
import { execSync } from 'node:child_process';
import net from 'node:net';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(ok ? port : null);
    };
    s.setTimeout(400, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

const status = sh('git status --porcelain');
const ports = (await Promise.all([5173, 5174, 5175, 5176, 5177].map(checkPort))).filter(Boolean);

const lines = [];
if (status) {
  const n = status.split('\n').length;
  lines.push(
    'Uncommitted changes at session start (' + n + ' file(s)):\n' + status + '\n' +
    'The user often runs parallel Claude sessions on this repo. Treat these diffs as ' +
    'potentially belonging to another active session: do not revert or absorb them, and ' +
    'if your task touches these same files, confirm with the user first.'
  );
} else {
  lines.push('Working tree was clean at session start.');
}

if (ports.length) {
  lines.push(
    'Ports listening right now: ' + ports.join(', ') + '. Caution: 5173/5174 are often a ' +
    'DIFFERENT Vite app ("Reodite"), so this repo\'s `npm run dev` usually lands on 5175+. ' +
    'Verify which app a port serves (check the page <title> or GET / content) before driving a browser at it.'
  );
} else {
  lines.push(
    'No dev server detected on 5173-5177. Start one with `npm run dev` (background) and read ' +
    'the actual port from the Vite output rather than assuming 5173.'
  );
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '[session-start hook] ' + lines.join('\n\n'),
    },
  })
);
