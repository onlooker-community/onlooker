import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The gap this closes is specific, and it is the one that actually happened.
//
// ErrorBoundary always accepted an onError prop, and its own tests always
// proved it calls that prop when given one. What nothing asserted was that App
// SUPPLIES one - and for the entire life of the blank-dashboard incident, it
// did not. The boundary worked perfectly and reported into a void.
//
// So this renders App itself, with a page rigged to throw during render, and
// follows the report all the way to the reporter. Mocking the boundary or
// calling onError directly would re-test what was never broken.

const reportClientError = vi.fn();
vi.mock("../lib/reportError", () => ({
	reportClientError: (...args: unknown[]) => reportClientError(...args),
	redactSecrets: (value: string) => value,
	installGlobalErrorReporting: () => {},
}));

// HomePage is the "/" route, so this throws on the first render App attempts.
vi.mock("../pages/HomePage", () => ({
	default: () => {
		throw new Error("deliberate render failure");
	},
}));

// A second throwing page, reached by navigating rather than mounted onto -
// HomePage above only covers a throw the boundary catches at mount. /signup is
// public and reachable by a real link from /login, which is not mocked.
vi.mock("../pages/SignupPage", () => ({
	default: () => {
		throw new Error("SignupPage exploded");
	},
}));

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({ user: null, loading: false }),
		RequireAuth: ({ children }: { children: React.ReactNode }) => children,
	},
}));

import App from "../App";

describe("a render error reaches the reporter", () => {
	beforeEach(() => {
		reportClientError.mockClear();
		// React logs caught errors to the console regardless; silence it so a
		// deliberate throw does not read as a failing suite.
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("reports it, rather than only showing a fallback", () => {
		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		// The fallback is the visible half and was never the problem.
		expect(screen.getByRole("alert")).toBeDefined();

		// This is the half that was missing.
		expect(reportClientError).toHaveBeenCalledTimes(1);
		const report = reportClientError.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(report.kind).toBe("render");
		expect(report.message).toBe("deliberate render failure");
	});

	// Without a component stack the report says a page broke but not which part
	// of it, which is most of the value of catching it at the boundary at all.
	it("includes where in the tree it happened", () => {
		render(
			<MemoryRouter initialEntries={["/"]}>
				<App />
			</MemoryRouter>,
		);

		const report = reportClientError.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(report.componentStack).toEqual(expect.any(String));
		expect(String(report.componentStack).length).toBeGreaterThan(0);
	});

	// Navigating INTO a throwing route commits differently than mounting onto
	// one: React runs the boundary's componentDidUpdate, with resetKey already
	// changed to the new route and the error already set, BEFORE
	// componentDidCatch runs for it. A guard that only checks the current
	// state clears an error that belongs to the route just arrived at, the
	// same subtree throws again on the re-render that follows, and it is
	// caught and reported a second time.
	it("reports a navigation-time throw once, not twice", () => {
		render(
			<MemoryRouter initialEntries={["/login"]}>
				<App />
			</MemoryRouter>,
		);
		expect(screen.queryByRole("alert")).toBeNull();

		fireEvent.click(screen.getByRole("link", { name: /sign up/i }));

		expect(screen.getByRole("alert")).toBeDefined();
		expect(reportClientError).toHaveBeenCalledTimes(1);
	});
});
