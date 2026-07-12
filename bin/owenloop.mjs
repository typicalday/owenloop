#!/usr/bin/env node
// Thin shim: all real logic lives in src/cli.ts (so it stays testable) and is
// shipped compiled to dist/cli.js. Node cannot type-strip files under
// node_modules, so the published package runs plain JS, not TypeScript source.
import { mainAsync } from '../dist/cli.js';

mainAsync(process.argv.slice(2)).then((code) => process.exit(code));
