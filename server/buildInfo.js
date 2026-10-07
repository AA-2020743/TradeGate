import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which code produced a response. A number on the page can only be traced to
 * the logic behind it if the commit is known; deploys here are `git pull`,
 * so the commit is read from the checkout at startup (or GIT_SHA, for image
 * builds that ship without .git).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readCommit(gitDirectory = path.join(root, '.git')) {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.trim();
  try {
    const head = readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(5);
    const loose = path.join(gitDirectory, ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
    // After `git gc` refs live only in packed-refs.
    const packed = path.join(gitDirectory, 'packed-refs');
    if (existsSync(packed)) {
      const line = readFileSync(packed, 'utf8').split('\n').find((entry) => entry.endsWith(` ${ref}`));
      if (line) return line.split(' ')[0];
    }
  } catch {
    // An unreadable checkout means unknown, not a crash at startup.
  }
  return null;
}

const commit = readCommit();

export const buildInfo = Object.freeze({
  commit,
  shortCommit: commit ? commit.slice(0, 7) : 'unknown',
  startedAt: new Date().toISOString(),
  node: process.version,
});
