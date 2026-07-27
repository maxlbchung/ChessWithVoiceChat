#!/usr/bin/env node
// Stop hook — runs `tsc -b` when TypeScript sources are dirty, and blocks the agent
// from finishing the turn while type errors exist (one forced fix round per turn).
//
// Cheap by default: skips entirely when no .ts/.tsx file is dirty, or when nothing
// changed since the last successful check (stamp file in .claude/, which is gitignored).
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const STAMP = path.join('.claude', '.typecheck-ok-stamp');

let stopHookActive = false;
try {
  const input = fs.readFileSync(0, 'utf8');
  stopHookActive = !!JSON.parse(input).stop_hook_active;
} catch {}

let porcelain = '';
try {
  porcelain = execSync('git status --porcelain', {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  process.exit(0); // fail open — never trap the agent because git hiccuped
}

const dirtyTs = porcelain
  .split('\n')
  .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
  .filter((f) => /\.(ts|tsx)$/.test(f));

if (dirtyTs.length === 0) process.exit(0);

// Skip when every dirty TS file predates the last successful typecheck.
try {
  const stampTime = fs.statSync(STAMP).mtimeMs;
  const newest = Math.max(
    ...dirtyTs.map((f) => {
      try {
        return fs.statSync(f).mtimeMs;
      } catch {
        return Infinity; // deleted/renamed file — force a recheck
      }
    })
  );
  if (newest < stampTime) process.exit(0);
} catch {} // no stamp yet — run the check

const res = spawnSync('npx tsc -b --pretty false', {
  shell: true,
  encoding: 'utf8',
  timeout: 110000,
});

if (res.error || res.signal) process.exit(0); // fail open on tooling trouble

if (res.status === 0) {
  try {
    fs.writeFileSync(STAMP, String(Date.now()));
  } catch {}
  process.exit(0);
}

const errors = ((res.stdout || '') + '\n' + (res.stderr || '')).trim();
const shortErrors = errors.split('\n').slice(0, 40).join('\n');

if (stopHookActive) {
  // Already blocked once this turn — let the agent stop, but surface the state loudly.
  process.stdout.write(
    JSON.stringify({
      systemMessage: 'tsc -b still failing after a fix round:\n' + shortErrors,
    })
  );
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      'TypeScript typecheck failed (`npx tsc -b`). Fix these errors before finishing:\n' +
      shortErrors +
      '\n\nIMPORTANT: if an error is in a file YOU did not edit this session, it is ' +
      'likely a parallel Claude session’s in-flight work (check `git diff <file>`). ' +
      'Do NOT fix or revert their code — explain the situation to the user and stop; ' +
      'this hook allows the stop on the second attempt.',
  })
);
