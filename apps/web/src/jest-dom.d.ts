// Ambient-only: pulls jest-dom's matcher types (toBeInTheDocument, etc.) onto
// vitest's `Assertion` interface for `tsc --noEmit`. The runtime half of this
// - actually registering the matchers - happens in vitest.setup.ts, which
// `tsc` never sees because tsconfig's `include` is scoped to `src`. Importing
// the same module from both places is deliberate rather than redundant: one
// is a type-only augmentation `tsc` needs to see, the other a side-effecting
// import vitest needs to run.
import "@testing-library/jest-dom/vitest";
