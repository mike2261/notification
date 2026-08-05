// MUST stay the first import in the test entry too: arktype's JIT compiles with
// `new Function`, which workerd forbids outside script startup. See
// src/arktype-config.ts.
import "../src/arktype-config";
