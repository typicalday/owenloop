/**
 * `capability-model.ts` — the settings map that says which model serves which
 * composed capability, and the two-pass lookup that resolves an order against
 * it.
 *
 * Two things are worth stating up front about what these tests protect.
 *
 * THE LOOKUP RUNS TWO FULL PASSES over the order's capabilities — every exact
 * key first, then every bare name — rather than resolving one capability at a
 * time. Per-capability resolution would let a bare row keyed on the FIRST
 * capability beat an exact row keyed on the second, which silently downgrades
 * an order the operator was specific about.
 *
 * VALIDATION THROWS OR SAYS NOTHING — there is no middle warn tier. A row that
 * is wrong no matter which model runs it (empty model, an effort that is not a
 * rung of `EFFORT_LADDER`) throws at settings load. The MODEL ID itself is never
 * judged: owenloop keeps no registry of which models exist, so a model released
 * after this file was last edited is the expected case, not a fault.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  capabilityNamePart,
  CapabilityModelError,
  EFFORT_LADDER,
  resolveCapabilityModel,
  validateCapabilityModels,
  type CapabilityModelMap,
} from '../src/agent/capability-model.ts';

// ---- capabilityNamePart ------------------------------------------------------

test('capabilityNamePart splits on the FIRST separator only', () => {
  assert.equal(capabilityNamePart('wise:deep'), 'wise');
  // A capability name may not contain `:` by install-time rule, so everything
  // after the first separator is modifier territory — not a second name.
  assert.equal(capabilityNamePart('wise:deep:extra'), 'wise');
  // A bare capability IS its own name part.
  assert.equal(capabilityNamePart('wise'), 'wise');
  assert.equal(capabilityNamePart(''), '');
});

// ---- resolveCapabilityModel --------------------------------------------------

const MAP: CapabilityModelMap = {
  'wise:deep': { model: 'claude-fable-5', effort: 'xhigh' },
  'build:deep': { model: 'claude-opus-5', effort: 'xhigh' },
  wise: { model: 'claude-opus-5', effort: 'high' },
  build: { model: 'claude-sonnet-5', effort: 'high' },
};

test('an exact compound row wins, and the resolution names the key that matched', () => {
  assert.deepEqual(resolveCapabilityModel(MAP, ['wise:deep']), {
    capability: 'wise:deep',
    match: 'exact',
    model: 'claude-fable-5',
    effort: 'xhigh',
  });
});

test('a compound with no exact row falls back to its bare name', () => {
  // The bare row is what makes a hub name-match order resolvable at all: the
  // hub can stamp `wise:express` on an order claimed by a crew bound only to
  // `wise`, and no shift has a `wise:express` row by construction.
  assert.deepEqual(resolveCapabilityModel(MAP, ['wise:express']), {
    capability: 'wise',
    match: 'bare',
    model: 'claude-opus-5',
    effort: 'high',
  });
});

test('a bare capability that hits its own row reports `exact`, never `bare`', () => {
  // `wise` is its own name part, so the second pass would find the same row.
  // Reporting that as a fallback would tell the hub a specific route was
  // missing when it was not — and `report_resolution` records that verbatim.
  const got = resolveCapabilityModel(MAP, ['wise']);
  assert.equal(got?.match, 'exact');
  assert.equal(got?.capability, 'wise');
});

test('an EXACT row on a later capability beats a BARE row on an earlier one', () => {
  // This is the whole reason for two passes. Resolving capability-by-capability
  // would take `build`'s bare row and never see that `wise:deep` was named
  // exactly — quietly running a deep step on the express model.
  const got = resolveCapabilityModel(MAP, ['build:express', 'wise:deep']);
  assert.equal(got?.capability, 'wise:deep');
  assert.equal(got?.match, 'exact');
  assert.equal(got?.model, 'claude-fable-5');
});

test('within one pass the FIRST capability wins — authored order is the tiebreak', () => {
  assert.equal(resolveCapabilityModel(MAP, ['wise:deep', 'build:deep'])?.model, 'claude-fable-5');
  assert.equal(resolveCapabilityModel(MAP, ['build:deep', 'wise:deep'])?.model, 'claude-opus-5');
  // Same rule in the bare pass.
  assert.equal(resolveCapabilityModel(MAP, ['build:x', 'wise:x'])?.capability, 'build');
});

test('no row at either level resolves to undefined — the caller refuses', () => {
  assert.equal(resolveCapabilityModel(MAP, ['paint:deep']), undefined);
  assert.equal(resolveCapabilityModel(MAP, ['paint']), undefined);
  // An order with no capabilities at all has nothing to resolve.
  assert.equal(resolveCapabilityModel(MAP, []), undefined);
  // An empty map refuses everything rather than defaulting to some model.
  assert.equal(resolveCapabilityModel({}, ['wise:deep']), undefined);
});

// ---- validateCapabilityModels: the hard faults -------------------------------

test('validateCapabilityModels throws on rows that are wrong under any model', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an empty capability key', { '': { model: 'claude-opus-5', effort: 'high' } }, /may not be empty/u],
    ['a whitespace capability key', { '  ': { model: 'claude-opus-5', effort: 'high' } }, /may not be empty/u],
    ['a string row', { wise: 'claude-opus-5' }, /must be an object with 'model' and 'effort'/u],
    ['a null row', { wise: null }, /must be an object with 'model' and 'effort'/u],
    ['an array row', { wise: [] }, /must be an object with 'model' and 'effort'/u],
    ['a missing model', { wise: { effort: 'high' } }, /\.model must be a non-empty string/u],
    ['an empty model', { wise: { model: '   ', effort: 'high' } }, /\.model must be a non-empty string/u],
    ['a non-string model', { wise: { model: 5, effort: 'high' } }, /\.model must be a non-empty string/u],
    ['a missing effort', { wise: { model: 'claude-opus-5' } }, /\.effort must be one of/u],
    ['an off-ladder effort', { wise: { model: 'claude-opus-5', effort: 'hihg' } }, /\.effort must be one of/u],
    ['a wrong-case effort', { wise: { model: 'claude-opus-5', effort: 'HIGH' } }, /\.effort must be one of/u],
  ];
  for (const [label, map, expected] of cases) {
    assert.throws(() => validateCapabilityModels(map), CapabilityModelError, `${label} should throw`);
    assert.throws(() => validateCapabilityModels(map), expected, `${label} message`);
  }
});

// ---- what validation deliberately does NOT judge -----------------------------

test('the MODEL id is never judged — owenloop does not decide which models exist', () => {
  // Deliberate, and the reason is in the module header: the Claude adapter's
  // effort union is a property of the HARNESS, not of any model, and the Codex
  // adapter does not validate effort at all. A model table here would either
  // restate `EFFORT_LADDER` under model-shaped keys or block a valid config on
  // an invention. Every rung is accepted under any model string.
  for (const effort of EFFORT_LADDER) {
    validateCapabilityModels({ wise: { model: 'some-brand-new-model', effort } });
  }
  validateCapabilityModels({});
});

test('the error context prefix is caller-supplied so the message names the real key path', () => {
  assert.throws(
    () => validateCapabilityModels({ wise: { model: '', effort: 'high' } }, 'suggestedSettings.capabilityModels'),
    /suggestedSettings\.capabilityModels\['wise'\]\.model/u,
  );
});
