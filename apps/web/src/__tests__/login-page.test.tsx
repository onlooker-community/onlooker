import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// LoginPage is the one auth page not built from the shared form components, so
// the suite covering those never touched it. Everything here is about what the
// page itself does: read the fields, call login, and route afterwards.
//
// auth.useAuth is the seam. Stubbing it lets a test drive a rejected login
// without standing up an API client, and leaves the parts under test real -
// the form submits for real and the router navigates for real, so a broken
// <form>, a submit button that stopped being one, or a dropped label
// association all show up as login simply never being called.
const mocks = vi.hoisted(() => ({
	login: vi.fn(),
	state: { error: null as string | null, loading: false },
}));

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			login: mocks.login,
			error: mocks.state.error,
			loading: mocks.state.loading,
		}),
	},
}));

const { default: LoginPage } = await import("../pages/LoginPage");

function renderLogin(entries: Array<string | object> = ["/login"]) {
	return render(
		<MemoryRouter initialEntries={entries}>
			<Routes>
				<Route path="/login" element={<LoginPage />} />
				<Route path="/dashboard" element={<p>dashboard reached</p>} />
				<Route path="/settings" element={<p>settings reached</p>} />
			</Routes>
		</MemoryRouter>,
	);
}

function fillAndSubmit(email = "someone@example.com", pw = "correct-horse") {
	fireEvent.change(screen.getByLabelText(/email/i), {
		target: { value: email },
	});
	fireEvent.change(screen.getByLabelText(/password/i), {
		target: { value: pw },
	});
	fireEvent.click(screen.getByRole("button", { name: /login/i }));
}

beforeEach(() => {
	mocks.login.mockReset();
	mocks.login.mockResolvedValue(undefined);
	mocks.state.error = null;
	mocks.state.loading = false;
});

describe("LoginPage", () => {
	it("hands the typed credentials to login", async () => {
		renderLogin();
		fillAndSubmit("someone@example.com", "correct-horse");
		await vi.waitFor(() =>
			expect(mocks.login).toHaveBeenCalledWith(
				"someone@example.com",
				"correct-horse",
			),
		);
	});

	it("sends the user to the dashboard once login resolves", async () => {
		renderLogin();
		fillAndSubmit();
		expect(await screen.findByText("dashboard reached")).toBeDefined();
	});

	// RequireAuth stashes the blocked page in location state. Losing this sends
	// everyone to the dashboard regardless of where they were headed, which is
	// mild enough to go unnoticed and annoying every single time.
	it("returns the user to the page they were blocked from", async () => {
		renderLogin([
			{ pathname: "/login", state: { from: { pathname: "/settings" } } },
		]);
		fillAndSubmit();
		expect(await screen.findByText("settings reached")).toBeDefined();
	});

	it("shows the reason when login is rejected, and stays put", async () => {
		mocks.login.mockRejectedValue(new Error("Invalid email or password"));
		renderLogin();
		fillAndSubmit();
		expect(await screen.findByText("Invalid email or password")).toBeDefined();
		expect(screen.queryByText("dashboard reached")).toBeNull();
	});

	// The provider surfaces failures it handled itself - an expired session, a
	// refresh that could not recover - separately from the throw above.
	it("shows an error raised by the auth provider", () => {
		mocks.state.error = "Your session expired";
		renderLogin();
		expect(screen.getByText("Your session expired")).toBeDefined();
	});

	// The shared AuthCard renders its form with noValidate, so `required` alone
	// stops holding empty submits back once this page uses it. Without a check
	// here, clicking Login on an untouched form fires a request with two empty
	// strings and reports whatever the server says about it.
	it("does not attempt a login with empty fields", async () => {
		renderLogin();
		fireEvent.click(screen.getByRole("button", { name: /login/i }));
		expect(await screen.findByText(/enter your email/i)).toBeDefined();
		expect(mocks.login).not.toHaveBeenCalled();
	});

	it("disables the form while a login is in flight", () => {
		mocks.state.loading = true;
		renderLogin();
		expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
			true,
		);
	});
});
