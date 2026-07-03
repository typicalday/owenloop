import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseElement,
  isElement,
  sealPath,
  sealStem,
  parseConsume,
  parseProduce,
  matchConsume,
  bindProduce,
  elementPath,
  isMemberOf,
} from '../src/paths.ts';

test('parseElement splits stem/index/suffix', () => {
  assert.deepEqual(parseElement('gather.source[3]'), {
    stem: 'gather.source',
    index: 3,
    suffix: '',
  });
  assert.deepEqual(parseElement('gather.source[12].formatcheck'), {
    stem: 'gather.source',
    index: 12,
    suffix: '.formatcheck',
  });
  assert.equal(parseElement('plan'), null);
});

test('isElement', () => {
  assert.equal(isElement('gather.source[0]'), true);
  assert.equal(isElement('plan'), false);
  assert.equal(isElement('gather.source.sealed'), false);
});

test('seal helpers', () => {
  assert.equal(sealPath('gather.source'), 'gather.source.sealed');
  assert.equal(sealStem('gather.source.sealed'), 'gather.source');
  assert.equal(sealStem('gather.source[3]'), null);
});

test('parseConsume — plain / map / reduce', () => {
  assert.equal(parseConsume('plan').mode, 'plain');
  const map = parseConsume('gather.source[$i]');
  assert.equal(map.mode, 'map');
  assert.equal(map.stem, 'gather.source');
  assert.equal(map.binder, 'i');
  assert.equal(map.suffix, '');
  const reduce = parseConsume('gather.source[*]');
  assert.equal(reduce.mode, 'reduce');
  assert.equal(reduce.stem, 'gather.source');
  assert.equal(reduce.suffix, '');
});

test('parseConsume — reduce with a single-level suffix', () => {
  const reduce = parseConsume('gather.source[*].child');
  assert.equal(reduce.mode, 'reduce');
  assert.equal(reduce.stem, 'gather.source');
  assert.equal(reduce.suffix, '.child');
});

test('parseConsume rejects a multi-level reduce suffix', () => {
  assert.throws(() => parseConsume('gather.source[*].a.b'));
});

test('parseConsume rejects collection-decl and literal index', () => {
  assert.throws(() => parseConsume('gather.source[]'));
  assert.throws(() => parseConsume('gather.source[3]'));
});

test('parseProduce — singleton / collection / map', () => {
  assert.equal(parseProduce('pr').kind, 'singleton');
  const coll = parseProduce('gather.source[]');
  assert.equal(coll.kind, 'collection');
  assert.equal(coll.stem, 'gather.source');
  const map = parseProduce('gather.source[$i].formatcheck');
  assert.equal(map.kind, 'map');
  assert.equal(map.stem, 'gather.source');
  assert.equal(map.binder, 'i');
  assert.equal(map.suffix, '.formatcheck');
});

test('parseProduce rejects reduce and literal index', () => {
  assert.throws(() => parseProduce('gather.source[*]'));
  assert.throws(() => parseProduce('gather.source[3]'));
});

test('matchConsume — plain', () => {
  const p = parseConsume('plan');
  assert.deepEqual(matchConsume(p, 'plan'), {});
  assert.equal(matchConsume(p, 'plan2'), null);
});

test('matchConsume — map binds index, respects suffix', () => {
  const p = parseConsume('gather.source[$i]');
  assert.deepEqual(matchConsume(p, 'gather.source[3]'), { index: 3 });
  // a map over the bare element must NOT match an element's child artifact
  assert.equal(matchConsume(p, 'gather.source[3].formatcheck'), null);
  // wrong stem
  assert.equal(matchConsume(p, 'other.source[3]'), null);
});

test('matchConsume — map with suffix matches the child lane', () => {
  const p = parseConsume('gather.source[$i].formatcheck');
  assert.deepEqual(matchConsume(p, 'gather.source[7].formatcheck'), { index: 7 });
  assert.equal(matchConsume(p, 'gather.source[7]'), null);
});

test('matchConsume — reduce matches every bare member', () => {
  const p = parseConsume('gather.source[*]');
  assert.deepEqual(matchConsume(p, 'gather.source[0]'), { index: 0 });
  assert.deepEqual(matchConsume(p, 'gather.source[99]'), { index: 99 });
  assert.equal(matchConsume(p, 'gather.source[0].formatcheck'), null);
});

test('matchConsume — suffixed reduce matches the child lane, not the bare member', () => {
  const p = parseConsume('gather.source[*].child');
  assert.deepEqual(matchConsume(p, 'gather.source[0].child'), { index: 0 });
  assert.equal(matchConsume(p, 'gather.source[0]'), null);
});

test('bindProduce / elementPath', () => {
  const p = parseProduce('gather.source[$i].formatcheck');
  assert.equal(bindProduce(p, 4), 'gather.source[4].formatcheck');
  assert.equal(elementPath('gather.source', 2), 'gather.source[2]');
  assert.throws(() => bindProduce(parseProduce('pr'), 1));
});

test('isMemberOf', () => {
  assert.equal(isMemberOf('gather.source', 'gather.source[5]'), true);
  assert.equal(isMemberOf('gather.source', 'gather.source[5].formatcheck'), false);
  assert.equal(isMemberOf('gather.source', 'other[5]'), false);
});
