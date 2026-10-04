// Registers jest-dom's matchers (toBeInTheDocument, etc.) on vitest's own
// `expect`. Added for task-11's page tests, which assert with those matchers
// rather than the toBeDefined()/toBeNull() style the rest of this suite uses
// - importing the `/vitest` entry point is what extends `expect` globally, so
// this file's only job is to exist and be imported once, via `setupFiles`
// below.
import "@testing-library/jest-dom/vitest";
