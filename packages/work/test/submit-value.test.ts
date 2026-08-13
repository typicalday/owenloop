import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeSubmitValue } from '../src/submit-value.ts';

// These cases mirror `owenloop-service` packages/hub-core/src/normalize-submit-value.ts.
// The two implementations must agree: a divergence signs bytes the hub did not
// store, and the consumer then rejects the artifact.

test('a non-string value passes through untouched', () => {
  const obj = { prUrl: 'https://example.test/1', number: 1 };
  assert.equal(normalizeSubmitValue(obj), obj);
  assert.equal(normalizeSubmitValue(42), 42);
  assert.equal(normalizeSubmitValue(null), null);
});

test('a JSON-encoded object string becomes the object the hub would store', () => {
  const raw = '{"prUrl":"https://example.test/145","number":145,"draft":true}';
  assert.deepEqual(normalizeSubmitValue(raw), {
    prUrl: 'https://example.test/145',
    number: 145,
    draft: true,
  });
});

test('a ```json fence is stripped before parsing', () => {
  const raw = '```json\n{"ok":true}\n```';
  assert.deepEqual(normalizeSubmitValue(raw), { ok: true });
});

test('bare newlines inside string values are escaped rather than failing the parse', () => {
  const raw = '{"summary":"line one\nline two"}';
  assert.deepEqual(normalizeSubmitValue(raw), { summary: 'line one\nline two' });
});

test('a string that is not JSON is returned unchanged for the hub to reject', () => {
  // The hub answers this with `artifact-normalization-failed` and its own
  // diagnostic text. Refusing locally would invent a failure the protocol
  // does not have and would hide that text from the agent.
  assert.equal(normalizeSubmitValue('not json at all'), 'not json at all');
});

test('JSON that parses to a non-object is returned unchanged', () => {
  // The hub stores objects only, so an array or a bare scalar is its refusal
  // to make, not ours.
  assert.equal(normalizeSubmitValue('[1,2,3]'), '[1,2,3]');
  assert.equal(normalizeSubmitValue('"just a quoted string"'), '"just a quoted string"');
  assert.equal(normalizeSubmitValue('null'), 'null');
});
