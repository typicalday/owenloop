/** One selected adapter owns a routed physical start. The selection gate may
 * inspect the registry while the parent chooses a candidate, but launch uses
 * only the captured adapter object and callable from the accepted resolution. */
import type { HarnessAdapter } from '../harness/contract.ts';

const refused = (): Error => new Error('routed agent adapter refused');

export function createRoutedAgentAdapterGate(
  lookup: (id: string) => HarnessAdapter | undefined,
  registered: () => string[],
) {
  let selected: { id: string; adapter: HarnessAdapter;
    start: NonNullable<HarnessAdapter['startRouted']> } | undefined;
  const start: NonNullable<HarnessAdapter['startRouted']> = (args, onEvent, launch) => {
    const captured = selected;
    if (!captured || captured.adapter.id !== captured.id
      || captured.adapter.startRouted !== captured.start) throw refused();
    return captured.start.call(captured.adapter, args, onEvent, launch);
  };
  return {
    harnessAvailable(id: string): boolean {
      const adapter = lookup(id);
      return adapter?.id === id && typeof adapter.startRouted === 'function';
    },
    resolveAdapter(chosenHarness: string | undefined, stepHarness: string | undefined) {
      const id = chosenHarness ?? stepHarness ?? '';
      const adapter = lookup(id), start = adapter?.startRouted;
      const eligible = adapter?.id === id && typeof start === 'function'
	&& (!selected || selected.id === id && selected.adapter === adapter && selected.start === start);
      if (eligible && adapter && start && !selected) selected = { id, adapter, start };
      return { id: id || '<none>', ...(eligible && adapter ? { adapter } : {}),
	registered: registered() };
    },
    start,
  };
}
