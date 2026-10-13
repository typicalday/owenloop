import { loadPrivateBacking, ready, endOriginal, fixedCode } from './facade.mjs';
let owner, output, bound, cleanup = true, stage = 'LOAD';
try {
  owner = loadPrivateBacking(process.env.JEV_DESCRIPTOR_ARTIFACT, process.env.JEV_DESCRIPTOR_SHA);
  stage = 'CHANNEL';
  output = owner.adoptInheritedChannel();
  stage = 'SPAWN_BIND';
  bound = owner.spawnTarget();
  if (!bound.capability || bound.refusal) throw Object.assign(new Error('OWNERSHIP'), { code: bound.refusal ?? 'OWNERSHIP' });
  stage = 'SEND';
  owner.send(output, bound.capability);
  stage = 'READY';
  await ready(bound.original, 'READY\n');
  process.stdout.write('NESTED_READY\n');
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('end', resolve));
  stage = 'SETTLEMENT';
  const ended = await endOriginal(bound.original);
  if (ended.code !== 0 || ended.signal !== 'NONE' || !ended.streamPolicyValid) throw Object.assign(new Error('FIXTURE'), { code: 'FIXTURE' });
} catch (error) {
  /* This fixed failure never includes PID, witness, exception or raw stream. */
  process.exitCode = 2;
  if (fixedCode(error) === 'CLEANUP') cleanup = false;
  process.stderr.write(JSON.stringify({ protocol: 'jev-owned-pair-nested-v1', status: 'REFUSED', stage, code: fixedCode(error) }) + '\n');
} finally {
  if (bound) { try { await endOriginal(bound.original); } catch { cleanup = false; } }
  if (bound?.capability) { try { owner.closePair(bound.capability); } catch (error) { if (fixedCode(error) !== 'CLOSED') cleanup = false; } }
  if (output) { try { owner.closeChannel(output); } catch { cleanup = false; } }
  if (!cleanup) process.exitCode = 2;
}
