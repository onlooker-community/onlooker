import { run } from "./cli";

// The whole executable. Dispatch lives in `./cli` so it can be imported by a
// test without this line firing; what stays here is the top-level await, which
// is how the exit code is set before the process ends. `tsconfig.json` targets
// ES2023 to allow it.
process.exitCode = await run(process.argv);

// Scratch change on a pull request that will never merge, to watch the release
// gate block it. Delete the branch rather than this line.
