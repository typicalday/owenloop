#!/usr/bin/env node
// Thin shim: Node strips the TypeScript types in src/cli.ts at load time
// (native type-stripping, Node >= 22.6 with --experimental-strip-types, on by
// default in 23.6+). All real logic lives in src/cli.ts so it stays testable.
import { main } from '../src/cli.ts';

process.exit(main(process.argv.slice(2)));
