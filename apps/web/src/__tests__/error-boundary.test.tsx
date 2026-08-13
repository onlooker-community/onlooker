import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "../components/ErrorBoundary";

// React logs every caught error to console.error. That is genuinely useful in a
// browser and pure noise here, where throwing is the point of every test.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	consoleError.mockRestore();
});

function Boom({ message = "kaboom" }: { message?: string }): JSX.Element {
	throw new Error(message);
}

describe("ErrorBoundary", () => {
	it("renders its children when nothing throws", () => {
		render(
			<MemoryRouter>
				<ErrorBoundary>
					<p>the page</p>
				</ErrorBoundary>
			</MemoryRouter>,
		);

		expect(screen.getByText("the page")).toBeDefined();
	});

	// The whole reason this exists. Before it, a throw here replaced the entire
	// app with an empty document - no message, no route change, nothing to act
	// on, and nothing in the UI saying anything had happened at all.
	it("shows a fallback instead of an empty document when a child throws", () => {
		render(
			<MemoryRouter>
				<ErrorBoundary>
					<Boom />
				</ErrorBoundary>
			</MemoryRouter>,
		);

		expect(screen.getByRole("alert")).toBeDefined();
		expect(screen.getByText(/something went wrong/i)).toBeDefined();
	});

	it("names the failure, so a report can say more than 'it broke'", () => {
		render(
			<MemoryRouter>
				<ErrorBoundary>
					<Boom message="Cannot read properties of undefined" />
				</ErrorBoundary>
			</MemoryRouter>,
		);

		expect(
			screen.getByText(/Cannot read properties of undefined/),
		).toBeDefined();
	});

	it("offers a way out", () => {
		render(
			<MemoryRouter>
				<ErrorBoundary>
					<Boom />
				</ErrorBoundary>
			</MemoryRouter>,
		);

		expect(screen.getByRole("button", { name: /reload/i })).toBeDefined();
		expect(screen.getByRole("link", { name: /home/i })).toBeDefined();
	});

	// A boundary that has caught stays caught. Without a reset the user is stuck
	// on the fallback for the rest of the session no matter where they navigate,
	// which is a worse failure than the one being reported.
	it("recovers when its key changes, so navigating away works", () => {
		const { rerender } = render(
			<MemoryRouter>
				<ErrorBoundary key="/broken">
					<Boom />
				</ErrorBoundary>
			</MemoryRouter>,
		);
		expect(screen.getByRole("alert")).toBeDefined();

		rerender(
			<MemoryRouter>
				<ErrorBoundary key="/fine">
					<p>a different page</p>
				</ErrorBoundary>
			</MemoryRouter>,
		);

		expect(screen.getByText("a different page")).toBeDefined();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("reports the error rather than swallowing it", () => {
		const onError = vi.fn();
		render(
			<MemoryRouter>
				<ErrorBoundary onError={onError}>
					<Boom message="reported upward" />
				</ErrorBoundary>
			</MemoryRouter>,
		);

		expect(onError).toHaveBeenCalled();
		expect((onError.mock.calls[0][0] as Error).message).toBe("reported upward");
	});

	// The boundary sits inside the router, not around it, so the links in its
	// fallback are live and one broken page does not strand the session.
	it("leaves routing usable when a route throws", () => {
		render(
			<MemoryRouter initialEntries={["/broken"]}>
				<Routes>
					<Route
						path="/broken"
						element={
							<ErrorBoundary>
								<Boom />
							</ErrorBoundary>
						}
					/>
				</Routes>
			</MemoryRouter>,
		);

		const home = screen.getByRole("link", { name: /home/i });
		expect(home.getAttribute("href")).toBe("/");
		fireEvent.click(home);
	});
});
