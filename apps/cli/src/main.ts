import { run } from "./cli";

// The whole executable. Dispatch lives in `./cli` so it can be imported by a
// test without this line firing; what stays here is the top-level await, which
// is how the exit code is set before the process ends. `tsconfig.json` targets
// ES2023 to allow it.
process.exitCode = await run(process.argv);
