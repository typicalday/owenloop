import { runVerified } from './loader.mjs';
try { await runVerified(import.meta.url); }
catch { process.exitCode = 2; process.stderr.write('JEV_DESCRIPTOR_ENTRY_REFUSED\n'); }
