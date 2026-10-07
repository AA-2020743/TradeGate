import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MODEL_REGISTRY } from './modelRegistry.js';
import { readCommit } from './buildInfo.js';

const source = readdirSync(new URL('./', import.meta.url))
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js') && name !== 'modelRegistry.js')
  .map((name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
  .join('\n');

test('every registered model is still published under that id', () => {
  // A registry that names a version the code no longer emits describes logic
  // that is not running - worse than no registry.
  const stale = MODEL_REGISTRY.filter((entry) => !source.includes(`'${entry.id}'`)).map((entry) => entry.id);
  assert.deepEqual(stale, []);
});

test('every registered track record exists', () => {
  const missing = MODEL_REGISTRY.filter((entry) => entry.trackRecord && !source.includes(`'${entry.trackRecord}'`)).map((entry) => entry.id);
  assert.deepEqual(missing, []);
});

test('every entry says what it reads and at least one way it fails', () => {
  for (const entry of MODEL_REGISTRY) {
    assert.ok(entry.inputs.length >= 1, `${entry.id} inputs`);
    assert.ok(entry.failureModes.length >= 1, `${entry.id} failure modes`);
    assert.ok(entry.measures.length > 20, `${entry.id} description`);
  }
  assert.equal(new Set(MODEL_REGISTRY.map((entry) => entry.id)).size, MODEL_REGISTRY.length, 'duplicate ids');
});

function fakeGit({ head, loose = {}, packed = null }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'git-'));
  writeFileSync(path.join(directory, 'HEAD'), head);
  for (const [ref, sha] of Object.entries(loose)) {
    mkdirSync(path.dirname(path.join(directory, ref)), { recursive: true });
    writeFileSync(path.join(directory, ref), `${sha}\n`);
  }
  if (packed) writeFileSync(path.join(directory, 'packed-refs'), packed);
  return directory;
}

test('the commit is read from a branch ref, from packed refs after gc, or from a detached head', () => {
  const sha = 'a'.repeat(40);
  const saved = process.env.GIT_SHA;
  delete process.env.GIT_SHA;
  try {
    assert.equal(readCommit(fakeGit({ head: 'ref: refs/heads/main\n', loose: { 'refs/heads/main': sha } })), sha);
    assert.equal(readCommit(fakeGit({ head: 'ref: refs/heads/main\n', packed: `# pack-refs\n${'b'.repeat(40)} refs/heads/other\n${sha} refs/heads/main\n` })), sha);
    assert.equal(readCommit(fakeGit({ head: `${sha}\n` })), sha);
    assert.equal(readCommit('/nonexistent/.git'), null, 'an unreadable checkout is unknown, not a crash');
  } finally {
    if (saved !== undefined) process.env.GIT_SHA = saved;
  }
});
