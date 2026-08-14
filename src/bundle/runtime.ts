import { createRequire } from 'node:module';
import { packageVersion } from '../package-version.ts';
import { BundleError } from './types.ts';
import type { BundleRuntimeRequirements } from './types.ts';

interface SemverApi {
  SemVer: new (version: string) => { version: string; build: string[] };
  gte(version: string, minimum: string): boolean;
}

const semver = createRequire(import.meta.url)('semver') as SemverApi;

/** Runtime features implemented by this Owenloop release. */
export const SUPPORTED_RUNTIME_FEATURES = Object.freeze([
  'harness-policy-enforcement.v1',
  'native-judge-policy-inheritance.v1',
  // A def may write `x.harness.permissionMode` as one of the three neutral
  // values (`ask`, `auto-safe`, `full-access`) and every adapter translates it
  // into the vendor mode with the same meaning, or refuses it at preflight.
  // A def that uses one MUST require this id: on a CLI that predates it, every
  // adapter refuses the neutral value as out-of-vocabulary, so the step fails
  // closed — correct, but with a message about a bad permission mode rather
  // than about an old runtime. Requiring the id moves the diagnosis to the
  // bundle check, before any order is offered.
  'neutral-approval-modes.v1',
] as const);

export interface RuntimeCompatibilityEnvironment {
  /** The running Owenloop package version. `0.0.0` is the unavailable-version sentinel. */
  version: string;
  /** Runtime feature identifiers implemented by the running Owenloop process. */
  features: ReadonlySet<string>;
}

export interface RuntimeCompatibilityResult {
  compatible: boolean;
  runningVersion: string;
  versionSatisfied: boolean;
  unsupportedFeatures: string[];
  diagnostics: string[];
}

/** True only for one canonical strict SemVer value, with no prefix, range, or whitespace. */
export function isCanonicalSemver(value: string): boolean {
  try {
    const parsed = new semver.SemVer(value);
    const canonical = parsed.build.length === 0
      ? parsed.version
      : `${parsed.version}+${parsed.build.join('.')}`;
    return canonical === value;
  } catch {
    return false;
  }
}

/**
 * Evaluate already-validated requirements against an injected runtime. Version
 * and feature requirements use AND semantics: every declared condition must
 * be satisfied.
 */
export function evaluateRuntimeCompatibility(
  requirements: BundleRuntimeRequirements,
  environment: RuntimeCompatibilityEnvironment,
): RuntimeCompatibilityResult {
  const diagnostics: string[] = [];
  let versionSatisfied = true;

  if (requirements.minVersion !== undefined) {
    if (environment.version === '0.0.0' || !isCanonicalSemver(environment.version)) {
      versionSatisfied = false;
      diagnostics.push(
				`bundle requires Owenloop >= ${requirements.minVersion}, but the running package version is unavailable (${environment.version}); install or upgrade Owenloop and retry`,
      );
    } else if (!semver.gte(environment.version, requirements.minVersion)) {
      versionSatisfied = false;
      diagnostics.push(
				`bundle requires Owenloop >= ${requirements.minVersion}, but the running version is ${environment.version}; install or upgrade Owenloop and retry`,
      );
    }
  }

  const unsupportedFeatures = (requirements.features ?? [])
    .filter((feature) => !environment.features.has(feature))
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  if (unsupportedFeatures.length > 0) {
    diagnostics.push(
      `bundle requires unsupported Owenloop runtime feature${unsupportedFeatures.length === 1 ? '' : 's'}: ${unsupportedFeatures.join(', ')}; install or upgrade Owenloop and retry`,
    );
  }

  return {
    compatible: versionSatisfied && unsupportedFeatures.length === 0,
    runningVersion: environment.version,
    versionSatisfied,
    unsupportedFeatures,
    diagnostics,
  };
}

/** Evaluate requirements against the production package version and advertised features. */
export function assertCurrentRuntimeCompatible(requirements: BundleRuntimeRequirements): void {
  const result = evaluateRuntimeCompatibility(requirements, {
    version: packageVersion(),
    features: new Set<string>(SUPPORTED_RUNTIME_FEATURES),
  });
  if (!result.compatible) {
    throw new BundleError(
      'RUNTIME_INCOMPATIBLE',
      `bundle.yaml.runtime: incompatible with this Owenloop runtime: ${result.diagnostics.join('; ')}`,
    );
  }
}
