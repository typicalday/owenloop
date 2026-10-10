/** Parent-internal diagnostic for an unchanged routed input refusal. Only
 * locally authored categories can cross this boundary; arbitrary verifier
 * text, paths and payloads become `unclassified`. Broker replies stay generic. */
const CODES = [
  'routed-private-order-out-of-scope', 'routed-reference-v2-malformed',
  'routed-reference-v2-unavailable', 'routed-recorded-reference-unavailable',
  'service-unavailable', 'service-unsupported-feedback',
  'routed-claim-unavailable', 'routed-binding-changed', 'routed-observation-expired',
  'private-order-out-of-scope', 'reference-v2-unavailable',
  'private-order-v2-mismatch', 'private-order-unwitnessed-field',
  'local-definition-verifier-unavailable', 'local-definition-unknown-digest',
  'local-definition-unknown-step', 'local-definition-ambiguous-step',
  'local-definition-integrity', 'local-definition-no-digest',
  'local-definition-missing-command', 'local-definition-unverified-def',
  'local-definition-origin-policy', 'local-definition-unverified-consumed',
  'local-offer-structure-mismatch', 'private-order-producer-proof-mismatch',
  'private-order-worker-mismatch', 'observation-expired',
  'order-structure-mismatch', 'output-structure-mismatch',
  'witness-set-mismatch', 'witness-version-mismatch', 'witness-value-mismatch',
  'unwitnessed-absence', 'extra-consumed-path', 'producer-proof-map-mismatch',
  'producer-relay-map-mismatch', 'workdir-mismatch', 'workdir-source-mismatch',
  'extra-workdir-witness', 'workdir-source-absent', 'workdir-witness-mismatch',
  'workdir-value-mismatch', 'producer-verifier-unavailable',
  'producer-proof-refused', 'command-definition-missing',
] as const;

export type RoutedInputWitnessCode = typeof CODES[number] | 'unclassified';
const KNOWN = new Set<string>(CODES);

export class RoutedInputWitnessRefusal extends Error {
  readonly #code: RoutedInputWitnessCode;

  constructor(reason: string) {
    super('routed input witness refused');
    this.#code = KNOWN.has(reason) ? reason as RoutedInputWitnessCode : 'unclassified';
  }

  get code(): RoutedInputWitnessCode { return this.#code; }
}
