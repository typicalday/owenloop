import { valueDigestHex } from './crypto/canonical.ts';
import { checkInterfaceCompatibility } from './implements.ts';
import { parseWorkflowCoordinate } from './store/types.ts';
import type {
  AssessedCandidate, CandidateAssessment, DefRef, DecisionSnapshot, InterfaceCallBinding,
  InvocationBinding, InvocationCall, InvocationCandidate, InvocationEvidence, JsonValue,
  WorkflowDef,
} from './types.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
export function jsonOnly(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || (!Array.isArray(value) && !record(value)) || seen.has(value)) return false;
  if (Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => d.get || d.set)) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(v => jsonOnly(v, seen));
  seen.delete(value);
  return valid;
}
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
export function validInvocationCall(v: unknown): v is InvocationCall {
  if (!exact(v, ['name', 'version', 'selection', 'signature', 'policy']) || !jsonOnly(v)
    || !nonempty(v.name) || !nonempty(v.version) || v.selection !== 'invocation') return false;
  if (!exact(v.policy, ['name', 'version', 'config']) || !nonempty(v.policy.name) || !nonempty(v.policy.version)) return false;
  if (!exact(v.signature, ['inputs', 'outputs'])) return false;
  return ['inputs', 'outputs'].every(side => {
    const list = (v.signature as Record<string, unknown>)[side];
    if (!Array.isArray(list)) return false;
    const names = new Set<string>();
    return list.every(a => {
      if (!record(a) || !nonempty(a.name) || names.has(a.name)
        || Object.keys(a).some(k => k !== 'name' && k !== 'schema')) return false;
      names.add(a.name);
      return a.schema === undefined || typeof a.schema === 'boolean' || record(a.schema);
    });
  });
}
export function validDefRef(v: unknown): v is DefRef {
  return exact(v, ['bundleDigest', 'workflowName']) && typeof v.bundleDigest === 'string'
    && /^[0-9a-f]{64}$/.test(v.bundleDigest) && nonempty(v.workflowName);
}
export function validCandidate(v: unknown): v is InvocationCandidate {
  if (!exact(v, ['target', 'DefRef']) || !validDefRef(v.DefRef) || typeof v.target !== 'string') return false;
  try { parseWorkflowCoordinate(v.target); return true; } catch { return false; }
}
export const evidenceDigest = (evidence: readonly InvocationEvidence[]): string => valueDigestHex(
  [...evidence].sort((a, b) => compare(a.childInput, b.childInput) || compare(a.parentPath, b.parentPath)));
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export const candidateSetDigest = (candidates: readonly AssessedCandidate[]): string => valueDigestHex(
  [...candidates].sort((a, b) => compare(String(a.candidate.target), String(b.candidate.target))
    || compare(String(a.candidate.DefRef?.bundleDigest), String(b.candidate.DefRef?.bundleDigest))
    || compare(String(a.candidate.DefRef?.workflowName), String(b.candidate.DefRef?.workflowName))));
export const invocationId = (b: Pick<InvocationBinding, 'key' | 'candidateSetDigest' | 'policyDigest' | 'selected'>): string =>
  valueDigestHex({ key: b.key, candidateSetDigest: b.candidateSetDigest, policyDigest: b.policyDigest, selected: b.selected });

/** Shared prerequisite; all missing claims precede all wiring failures. */
export function inheritedBindingAssessment(def: WorkflowDef, bindings: readonly InterfaceCallBinding[] = []): CandidateAssessment {
  const legacy = def.steps.filter(s => s.callsInterface !== undefined && s.callsInterface.selection !== 'invocation');
  const pairs = legacy.map(step => ({ step, binding: bindings.find(b =>
    b.interface.name === step.callsInterface!.name && b.interface.version === step.callsInterface!.version) }));
  if (pairs.some(p => !p.binding)) return { kind: 'ineligible', code: 'legacy-binding-missing' };
  if (pairs.some(p => Object.keys(p.step.callsInputs ?? {}).some(name => !p.binding!.signature.inputs.some(i => i.name === name)))) {
    return { kind: 'ineligible', code: 'legacy-binding-wiring' };
  }
  return { kind: 'eligible' };
}
export function assessContract(call: InvocationCall, wiring: Record<string, string>, def: WorkflowDef,
  bindings: readonly InterfaceCallBinding[] = []): CandidateAssessment {
  const claims = def.x?.implements;
  if (!Array.isArray(claims) || !claims.some(c => exact(c, ['name', 'version']) && c.name === call.name && c.version === call.version)) {
    return { kind: 'ineligible', code: 'implements' };
  }
  if (Object.keys(wiring).some(n => !def.inputs.some(i => i.name === n) || !call.signature.inputs.some(i => i.name === n))) {
    return { kind: 'ineligible', code: 'wiring' };
  }
  if (def.outputs?.length !== 1 || !def.steps.some(s => s.produces.some(p => p.stem === def.outputs![0] && p.kind === 'singleton'))) {
    return { kind: 'ineligible', code: 'output' };
  }
  if (!checkInterfaceCompatibility(call.signature, def).compatible) return { kind: 'ineligible', code: 'signature' };
  return inheritedBindingAssessment(def, bindings);
}

/** Strict transport validation; hashes are checked independently of host claims. */
export function validSnapshot(v: unknown): v is DecisionSnapshot {
  if (!exact(v, ['key', 'contract', 'policyDigest', 'evidence', 'candidates', 'candidateSetDigest', 'admission']) || !jsonOnly(v)
    || !exact(v.key, ['parentWorkflow', 'parentDefRef', 'callPath', 'evidenceDigest'])
    || !validDefRef(v.key.parentDefRef) || !nonempty(v.key.parentWorkflow) || !nonempty(v.key.callPath)
    || !validInvocationCall(v.contract) || !exact(v.admission, ['rootWorkflow', 'epoch'])
    || !nonempty(v.admission.rootWorkflow) || !Number.isSafeInteger(v.admission.epoch) || Number(v.admission.epoch) < 0
    || !Array.isArray(v.evidence) || !Array.isArray(v.candidates)) return false;
  if (!v.evidence.every(e => exact(e, ['childInput', 'parentPath', 'version', 'value']) && nonempty(e.childInput)
    && nonempty(e.parentPath) && Number.isSafeInteger(e.version) && Number(e.version) >= 0)) return false;
  const identities = new Set<string>();
  if (!v.candidates.every(c => {
    if (!exact(c, ['candidate', 'assessment']) || !record(c.candidate) || !record(c.assessment)) return false;
    const a = c.assessment;
    if (!(exact(a, ['kind']) && a.kind === 'eligible') && !(exact(a, ['kind', 'code']) && (
      (a.kind === 'invalid' && ['malformed-ref', 'unresolved', 'digest-mismatch', 'name-mismatch'].includes(String(a.code)))
      || (a.kind === 'ineligible' && ['implements', 'wiring', 'output', 'signature', 'legacy-binding-missing', 'legacy-binding-wiring'].includes(String(a.code)))))) return false;
    const identity = valueDigestHex(c.candidate);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  })) return false;
  const s = v as unknown as DecisionSnapshot;
  return s.policyDigest === valueDigestHex(s.contract.policy) && s.key.evidenceDigest === evidenceDigest(s.evidence)
    && s.candidateSetDigest === candidateSetDigest(s.candidates);
}
export function decodeBinding(value: unknown): InvocationBinding {
  if (!exact(value, ['id', 'selected', 'key', 'contract', 'policyDigest', 'evidence', 'candidates', 'candidateSetDigest', 'admission'])) {
    throw new Error('corrupt call_invocation shape');
  }
  const { id, selected, ...snapshot } = value;
  if (!validSnapshot(snapshot) || !exact(selected, ['target', 'DefRef', 'signature'])
    || !validCandidate({ target: selected.target, DefRef: selected.DefRef })
    || valueDigestHex(selected.signature) !== valueDigestHex(snapshot.contract.signature)) throw new Error('corrupt call_invocation body');
  const b = value as unknown as InvocationBinding;
  if (id !== invocationId(b)) throw new Error('corrupt call_invocation id');
  if (!b.candidates.some(c => c.assessment.kind === 'eligible' && valueDigestHex(c.candidate) === valueDigestHex({ target: b.selected.target, DefRef: b.selected.DefRef }))) throw new Error('corrupt call_invocation selection');
  return b;
}
