import { runModifierInit } from '../util/modifier-init.ts';

export async function run(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command !== 'modifier-init') {
    process.stderr.write(`owenloop util: unknown command '${command ?? ''}'\n`);
    process.stderr.write('usage: owenloop util modifier-init --default <value>\n');
    return 2;
  }
  return runModifierInit(rest);
}
