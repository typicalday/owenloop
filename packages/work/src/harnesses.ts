/**
 * THE composition root for the harness registry — the one file in `src/` that
 * names the adapter modules, and the only file that decides which adapter is the
 * default.
 *
 * WHY THIS FILE EXISTS. `src/harness/registry.ts` starts empty and deliberately
 * forbids a barrel, so somebody has to import each adapter module for its
 * `register(...)` side effect to fire. Through Phase 5 that somebody was TWO
 * files — `src/roles/agent-run.ts` and `src/roles/lint.ts` — each carrying the
 * same import pair, kept in the same order BY HAND. Phase 6 collapsed them into
 * this module for two reasons:
 *
 *  1. ORDER IS LOAD-BEARING AND MUST HAVE ONE OWNER. `defaultHarnessId()`
 *     returns `registeredHarnessIds()[0]`, i.e. whichever adapter registered
 *     first. Two roots meant two places that had to agree, and a reorder in one
 *     of them would silently change which harness runs a step that names none.
 *     One file, one order, and `test/vendor-gate.test.ts` asserts the resulting
 *     default explicitly so an accidental reorder fails a test.
 *  2. IT KEEPS THE VENDOR-NAMING SURFACE SMALL. `test/vendor-gate.test.ts`
 *     allowlists the files under `src/`/`bin/` that may name a harness vendor.
 *     Consolidating drops that allowlist from five entries to four.
 *
 * SAFE BY ESM SEMANTICS: module evaluation is cached, so each adapter's
 * `register(...)` fires exactly once no matter how many modules import this one.
 *
 * IMPORT ORDER — DO NOT SORT THIS BLOCK. The FIRST id registered is the default
 * harness. `claude.ts` is first and `claude-code` is therefore the default; that
 * matches the pre-consolidation order in `src/roles/agent-run.ts` and is pinned
 * by a test.
 *
 * Importers: `src/roles/agent-run.ts` (the worker), `src/roles/lint.ts` (lint
 * judges a harness-less step by the SAME default that will run it), and
 * `src/roles/sessions.ts` (it maps a recorded harness id to that adapter's
 * resume command). A new caller of `adapterFor` / `defaultHarnessId` imports
 * THIS module — it does not add adapter imports of its own.
 */
import './harness/claude.ts';
import './harness/codex.ts';
