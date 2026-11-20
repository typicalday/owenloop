import assert from 'node:assert/strict';
import { statusProjection, namespaceProjection, mountProjection, validateContext, safeInteger, canonicalResult, kernelProjection } from './metadata.mjs';

// Pure declared fixtures; no procfs, tool, target, network or subprocess access.
const names = [];
function test(name, fn) { fn(); names.push(name); }
const status = 'Uid:\t1000 1000 1000 1000\nGid:\t1000 1000 1000 1000\nGroups:\t1000 1001\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000001\nCapAmb:\t0000000000000000\nNoNewPrivs:\t0\nSeccomp:\t2\n';
const env = { JEV_REPOSITORY:'typicalday/owenloop', JEV_HEAD_REPOSITORY:'typicalday/owenloop', JEV_PR:'369',
  JEV_BRANCH:'jev-routing-foundation-20261008', JEV_EVENT:'pull_request', JEV_ACTION:'synchronize', JEV_RUN_ID:'123', JEV_RUN_ATTEMPT:'1', JEV_JOB:'linux-metadata-preflight', JEV_HEAD:'a'.repeat(40), JEV_ADMITTED_HEAD:'a'.repeat(40), JEV_BASE:'b4ead192326ba607558cd3bb7687209cbb7c8165' };
const mount = '31 21 0:4 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw,hidepid=2\n';
test('STATUS_SAFE_CLASSIFICATIONS', () => {
  const x=statusProjection(status); assert.equal(x.capabilities.bounding,'NONZERO'); assert.equal(x.seccomp,'FILTER');
  assert.equal(x.uid.fourEqual,true); assert.equal(JSON.stringify(x).includes('1000'),false);
});
test('STATUS_MISSING_UID_REFUSED', () => assert.throws(() => statusProjection(status.replace(/^Uid:.*\n/,''))));
test('STATUS_DUPLICATE_UID_REFUSED', () => assert.throws(() => statusProjection(status+'Uid: 1 1 1 1\n')));
test('STATUS_INVALID_CAPABILITY_REFUSED', () => assert.throws(() => statusProjection(status.replace('CapEff:\t0000000000000000','CapEff:\tINVALID'))));
test('STATUS_GROUP_OVERFLOW_REFUSED', () => assert.throws(() => statusProjection(status.replace('1000 1001',Array.from({length:65},(_,i)=>i+1).join(' ')))));
test('STATUS_INVALID_SECCOMP_REFUSED', () => assert.throws(() => statusProjection(status.replace('Seccomp:\t2','Seccomp:\t9'))));
test('NAMESPACE_HASH_ONLY', () => { const x=namespaceProjection('pid','pid:[12345]','pid:[12345]'); assert.equal(x.identitySha256.length,64); assert.equal(JSON.stringify(x).includes('12345'),false); });
test('NAMESPACE_CHANGE_REFUSED', () => assert.throws(() => namespaceProjection('pid','pid:[1]','pid:[2]')));
test('NAMESPACE_INVALID_KIND_REFUSED', () => assert.throws(() => namespaceProjection('net','net:[1]','net:[1]')));
test('PROCFS_FIXED_OPTIONS', () => { const x=mountProjection(mount); assert.equal(x.hidepid,'2'); assert.equal(x.readOnly,false); });
test('PROCFS_AMBIGUOUS_MOUNT_REFUSED', () => assert.throws(() => mountProjection(mount+mount)));
test('PROCFS_INVALID_HIDEPID_REFUSED', () => assert.throws(() => mountProjection(mount.replace('hidepid=2','hidepid=99'))));
test('CONTEXT_EXACT_HEAD', () => { const x=validateContext(env); assert.equal(x.sameRepositoryHeadGate,true); });
test('CONTEXT_UNADMITTED_HEAD_REFUSED', () => assert.throws(() => validateContext({...env,JEV_ADMITTED_HEAD:'b'.repeat(40)})));
test('CONTEXT_FORK_REFUSED', () => assert.throws(() => validateContext({...env,JEV_HEAD_REPOSITORY:'foreign/repo'})));
test('CONTEXT_CHANGED_BASE_REFUSED', () => assert.throws(() => validateContext({...env,JEV_BASE:'b'.repeat(40)})));
test('CONTEXT_REOPENED_EVENT_REFUSED', () => assert.throws(() => validateContext({...env,JEV_ACTION:'reopened'})));
test('INTEGER_UNSAFE_REFUSED', () => assert.throws(() => safeInteger('9999999999999999')));
test('INPUT_OVERFLOW_REFUSED', () => assert.throws(() => statusProjection('x'.repeat(65537))));
test('OUTPUT_OVERFLOW_REFUSED', () => assert.throws(() => canonicalResult({value:'x'.repeat(65536)})));
test('KERNEL_NUMERIC_HASH_ONLY', () => { const x=kernelProjection('6.12.0-hosted'); assert.deepEqual(x.numericVersion,[6,12,0]); assert.equal(JSON.stringify(x).includes('hosted'),false); });
test('KERNEL_UNRECOGNIZED_REFUSED', () => assert.throws(() => kernelProjection('PRIVATE')));
test('CONTEXT_RUN_ID_REFUSED', () => assert.throws(() => validateContext({...env,JEV_RUN_ID:'PRIVATE'})));
test('CONTEXT_ATTEMPT_REFUSED', () => assert.throws(() => validateContext({...env,JEV_RUN_ATTEMPT:'0'})));
test('CONTEXT_JOB_REFUSED', () => assert.throws(() => validateContext({...env,JEV_JOB:'other'})));
test('PROCFS_SUBSET_CLASSIFIED', () => assert.equal(mountProjection(mount.replace('hidepid=2','hidepid=2,subset=pid')).subset,'PID'));
test('PROCFS_SUBSET_UNKNOWN_REFUSED', () => assert.throws(() => mountProjection(mount.replace('hidepid=2','hidepid=2,subset=unknown'))));
process.stdout.write(JSON.stringify({protocol:'jev-linux-metadata-fixture-controls-js-v2',syntheticOnly:true,
  backendUsed:false,procfsRead:false,subprocessUsed:false,passed:names.length,failed:0,cases:names})+'\n');
