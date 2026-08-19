// This file demonstrates what the Exercode server runs for a problem without debug.ts.
// A real standard stdio problem must NOT commit this file; this comment marks it as custom
// so that the exercode CLI does not reject it as a copy of the default harness.
import { stdioDebugPreset } from '@exercode/problem-utils/presets/stdio';

await stdioDebugPreset(import.meta.dirname);
