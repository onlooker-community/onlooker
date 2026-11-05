import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// RequireAuth honors unavailableFallback the way packages/auth-react does:
// with no user and the session unreachable, it renders the fallback with the
// retry time and the retry action. A passthrough mock would render the page
// and prove nothing.
const retry = vi.fn();
const RETRY_AT = Date.now() + 30_000;

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			user: null,
			loading: false,
			unavailable: { retryAt: RETRY_AT },
			retrySession: retry,
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
		RequireAuth: ({
			unavailableFallback,
		}: {
			children: React.ReactNode;
			unavailableFallback?: (s: {
				retryAt: number;
				retry: () => void;
			}) => React.ReactNode;
		}) => unavailableFallback?.({ retryAt: RETRY_AT, retry }) ?? null,
	},
}));

const { default: App } = await import("../App");

describe("an authenticated route while the session can't be checked", () => {
	it("says so inside the app frame and offers to try again", () => {
		render(
			<MemoryRouter initialEntries={["/machines"]}>
				<App />
			</MemoryRouter>,
		);

		expect(screen.getByRole("navigation", { name: /sections/i })).toBeDefined();
		const status = screen.getByRole("status");
		expect(status.textContent).toMatch(/can't reach onlooker right now/i);
		expect(status.textContent).toMatch(/trying again in 30 s/i);

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(retry).toHaveBeenCalledTimes(1);
	});

	// ONL-247. Past zero the notice reads "Trying again…" and has nothing left
	// to count, so its interval goes.
	it("stops counting down once it reaches zero", () => {
		vi.useFakeTimers({ now: RETRY_AT - 2_000 });
		try {
			render(
				<MemoryRouter initialEntries={["/machines"]}>
					<App />
				</MemoryRouter>,
			);
			const counting = vi.getTimerCount();

			act(() => {
				vi.advanceTimersByTime(3_000);
			});
			expect(screen.getByRole("status").textContent).toMatch(/trying again…/i);
			expect(vi.getTimerCount()).toBe(counting - 1);

			act(() => {
				vi.advanceTimersByTime(5_000);
			});
			expect(vi.getTimerCount()).toBe(counting - 1);
		} finally {
			vi.useRealTimers();
		}
	});
});
