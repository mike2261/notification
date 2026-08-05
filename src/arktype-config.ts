import { configure } from "arktype/config";

// Cloudflare Workers only allows code generation from strings (new Function)
// DURING top-level script startup, never in the request phase. The startup-CPU
// deferral moves most arktype type() construction into first request / DO
// activation, where arktype's default JIT would throw
// "EvalError: Code generation from strings disallowed for this context".
// jitless makes arktype interpret validators instead of compiling them.
// This module MUST be imported before anything that imports "arktype"
// (it is the first import of src/index.ts and tests/setup.ts).
configure({ jitless: true });
