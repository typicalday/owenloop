/** Step loader for a routed agent's public-only signed definition stage. */
import { owedSchema } from '../../../../src/model.ts';
import { validModelOrderFields } from '../order-definition-binding.ts';
import { parseHarnessCarrier } from '../bundle/fetch.ts';
import type { NormalizedStepSpec } from '../bundle/types.ts';
import type { InstructionResolver } from '../exec/instructions.ts';
import { normalizeStepPermissions, validateHarnessOptions } from '../harness/permissions.ts';
import type { OrderPacket } from '../hub/types.ts';

export function createRoutedAgentStepLoader(args: {
  instructions: InstructionResolver;
  instructionCwd: string;
  workflow: string; run: string;
  err: (line: string) => void;
}): (order: OrderPacket) => Promise<NormalizedStepSpec | null> {
  return async order => {
    try {
      const resolved = await args.instructions.resolveStep(order);
      if (!resolved.ok || !validModelOrderFields(resolved.step, order, resolved.inputNames))
	throw new Error();
      // The role installs its public-only process environment before calling
      // this loader. Only a verified bundle path may reach the provider child.
      if (resolved.bundleDir) process.env.OWENLOOP_BUNDLE_DIR = resolved.bundleDir;
      else delete process.env.OWENLOOP_BUNDLE_DIR;
      process.env.OWENLOOP_INSTRUCTION_CWD = args.instructionCwd;
      process.env.OWENLOOP_WORKFLOW = args.workflow;
      process.env.OWENLOOP_RUN = args.run;
      const carrier = parseHarnessCarrier(resolved.step as unknown as Record<string, unknown>,
	order.workflow, resolved.step.name);
      if (carrier.harnessOptions) {
	const errors = validateHarnessOptions(carrier.harnessOptions, resolved.step.name)
	  .filter(finding => finding.severity === 'error');
	if (errors.length) throw new Error();
      }
      const owedSchemas: NonNullable<NormalizedStepSpec['owedSchemas']> = Object.create(null);
      if (Array.isArray(resolved.step.produces)) {
	for (const path of new Set([...order.owes.map(owed => owed.path), ...order.outputs])) {
	  const declared = owedSchema(resolved.step, path);
	  if (declared) owedSchemas[path] = { schema: declared.schema,
	    schemaAppliesTo: declared.appliesTo };
	}
      }
      return { step: resolved.step.name, brief: resolved.step.body,
	...(carrier.harness ? { harness: carrier.harness } : {}),
	permissions: normalizeStepPermissions(carrier.harnessOptions, resolved.step), owedSchemas };
    } catch {
      args.err('owenloop work agent-run: routed signed step refused');
      return null;
    }
  };
}
