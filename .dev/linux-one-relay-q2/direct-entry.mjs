import { runVerified } from '../../loader.mjs';
try { await runVerified(import.meta.url); }
catch { process.exitCode = 2; process.stderr.write('JEV_ONE_RELAY_Q2_ENTRY_REFUSED\n'); }
