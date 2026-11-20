import { loadPrivateBacking, ready, endOriginal, fixedCode } from './facade.mjs';
const cases = [], originals = [], channels = [], capabilities = [];
let owner, stage = 'LOAD', status = 'SUPPORTED', code = 'NOT_APPLICABLE', cleanup = true;
function need(v) { if (!v) throw Object.assign(new Error('FIXTURE'), { code: 'FIXTURE' }); }
function needBound(v) { if (!v.capability || v.refusal) throw Object.assign(new Error('OWNERSHIP'), { code: v.refusal ?? 'OWNERSHIP' }); }
function checkSample(v) {
  need(Number.isInteger(v.count) && v.count >= 2 && v.count < 128);
  need(Reflect.ownKeys(v).length === 7);
  for (const k of ['twoPasses','allStatesLive','sameTaskDescriptors','sameProcessIdentity','completeEOF','cleanupKnown']) need(v[k] === true);
}
try {
  owner = loadPrivateBacking(process.env.JEV_DESCRIPTOR_ARTIFACT, process.env.JEV_DESCRIPTOR_SHA);
  stage = 'DIRECT_CHANNEL';
  const direct = owner.openChannel(); channels.push(direct);
  stage = 'DIRECT_SPAWN_BIND';
  const target = owner.spawnTarget(); originals.push(target.original);
  if (target.capability) capabilities.push(target.capability);
  needBound(target);
  stage = 'DIRECT_SEND_RECEIVE';
  owner.send(direct, target.capability);
  const received = owner.receive(direct); capabilities.push(received);
  stage = 'DIRECT_READY';
  await ready(target.original, 'READY\n');
  stage = 'DIRECT_ENDPOINT';
  checkSample(owner.sample(received)); cases.push('DIRECT_OWNER_FRESH_ENDPOINT');
  stage = 'CLOSED_HANDLE';
  owner.closePair(received); capabilities.pop();
  let refused = false;
  try { owner.sample(received); } catch (error) { refused = fixedCode(error) === 'CLOSED'; }
  need(refused); cases.push('CLOSED_HANDLE_REFUSED');
  stage = 'UNOWNED_HANDLE';
  refused = false;
  try { owner.sample(Object.freeze({})); } catch (error) { refused = fixedCode(error) === 'FIXTURE'; }
  need(refused); cases.push('UNOWNED_HANDLE_REFUSED');
  stage = 'DIRECT_SETTLEMENT';
  const directEnd = await endOriginal(target.original);
  need(directEnd.code === 0 && directEnd.signal === 'NONE' && directEnd.streamPolicyValid);
  stage = 'NESTED_CHANNEL';
  const nested = owner.openChannel(); channels.push(nested);
  stage = 'NESTED_OWNER_BIND';
  const supervisor = owner.spawnNested(nested); originals.push(supervisor.original);
  if (supervisor.capability) capabilities.push(supervisor.capability);
  needBound(supervisor);
  stage = 'NESTED_READY';
  await ready(supervisor.original, 'NESTED_READY\n');
  stage = 'NESTED_RECEIVE';
  const pair = owner.receive(nested); capabilities.push(pair);
  stage = 'NESTED_ENDPOINT';
  checkSample(owner.sample(pair)); cases.push('NESTED_GENUINE_OWNER_FRESH_ENDPOINT');
  stage = 'NESTED_SETTLEMENT';
  const nestedEnd = await endOriginal(supervisor.original);
  need(nestedEnd.code === 0 && nestedEnd.signal === 'NONE' && nestedEnd.streamPolicyValid);
  stage = 'EXITED_REAPED_CHANNEL';
  const exitedChannel = owner.openChannel(); channels.push(exitedChannel);
  const exited = owner.spawnTarget(); originals.push(exited.original);
  if (exited.capability) capabilities.push(exited.capability);
  needBound(exited);
  owner.send(exitedChannel, exited.capability);
  const exitedPair = owner.receive(exitedChannel); capabilities.push(exitedPair);
  await ready(exited.original, 'READY\n');
  stage = 'EXITED_REAPED_SETTLEMENT';
  const exitedEnd = await endOriginal(exited.original);
  need(exitedEnd.code === 0 && exitedEnd.signal === 'NONE' && exitedEnd.bothPipesEOF && exitedEnd.streamPolicyValid);
  stage = 'EXITED_REAPED_HANDLE';
  refused = false;
  try { owner.sample(exitedPair); } catch (error) { refused = fixedCode(error) === 'IDENTITY'; }
  need(refused); cases.push('EXITED_AND_REAPED_HANDLE_REFUSED');
  for (const [mode, detail, caseName] of [
    ['MALFORMED_FRAME','MALFORMED_FRAME','MALFORMED_FRAME_REFUSED'],
    ['EXTRA_RIGHTS','EXTRA_RIGHTS','EXTRA_RIGHTS_REFUSED'],
    ['TRUNCATED_RIGHTS','CONTROL_TRUNCATED','CONTROL_TRUNCATED_RIGHTS_REFUSED'],
  ]) {
    stage = mode;
    const output = owner.openChannel(); channels.push(output);
    const bound = owner.spawnTarget(); originals.push(bound.original);
    if (bound.capability) capabilities.push(bound.capability);
    needBound(bound);
    await ready(bound.original, 'READY\n');
    owner.sendNegative(output, bound.capability, mode);
    refused = false;
    try {
      const unexpected = owner.receive(output); capabilities.push(unexpected);
    } catch (error) { refused = fixedCode(error) === 'CHANNEL'; }
    need(refused && owner.negativeDetail(output) === detail);
    const ended = await endOriginal(bound.original);
    need(ended.code === 0 && ended.signal === 'NONE' && ended.bothPipesEOF && ended.streamPolicyValid);
    cases.push(caseName);
  }
} catch (error) {
  status = 'UNSUPPORTED'; code = fixedCode(error); if (code === 'CLEANUP') cleanup = false; process.exitCode = 2;
} finally {
  for (const original of originals) { try { await endOriginal(original); } catch { cleanup = false; } }
  for (const cap of capabilities) { try { owner.closePair(cap); } catch (error) { if (fixedCode(error) !== 'CLOSED') cleanup = false; } }
  for (const output of channels) { try { owner.closeChannel(output); } catch { cleanup = false; } }
}
if (!cleanup) { status = 'UNSUPPORTED'; stage = 'CLEANUP'; code = 'CLEANUP'; process.exitCode = 2; }
const result = { protocol: 'jev-owned-spawn-pair-negative-fixture-v1', status, stage, code, cases, cleanupKnown: cleanup, sequentialEndpointOnly: true, nativeRecoveryAccepted: false };
process.stdout.write(JSON.stringify(result) + '\n');
