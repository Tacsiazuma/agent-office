import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Dog } from '../src/server/dog.js';
import { dogDefaults } from '../src/shared/dog.js';

// A floor's dog gets its breed from the floor's id, unless the floor's dog.json names one.

function dogIn(json: string | undefined) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dog-'));
  if (json !== undefined) writeFileSync(path.join(dir, 'dog.json'), json);
  const dog = new Dog('floor-a', dir, { workers: () => [], people: () => [], send: () => {} });
  return { dog, dir, done: () => { dog.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("dog.json can name the dog's breed, and renaming keeps it", () => {
  const { dog, dir, done } = dogIn('{"breed":"dachshund"}');
  try {
    assert.equal(dog.view().breed, 'dachshund');
    dog.rename('Rex');
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'dog.json'), 'utf8')), { name: 'Rex', breed: 'dachshund' });
  } finally { done(); }
});

test('a missing or unknown breed in dog.json falls back to the floor id, and renaming does not write one', () => {
  for (const json of [undefined, '{"breed":"poodle"}', 'not json']) {
    const { dog, dir, done } = dogIn(json);
    try {
      assert.equal(dog.view().breed, dogDefaults('floor-a').breed);
      dog.rename('Rex');
      assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'dog.json'), 'utf8')), { name: 'Rex' });
    } finally { done(); }
  }
});
