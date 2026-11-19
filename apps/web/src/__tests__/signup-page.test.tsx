import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// SignupPage hands a new account to "/" and lets RootRedirect pick the landing
// page, so a change to where signed-in people land needs no edit here. auth is
// stubbed the same way as in the login page suite.
const mocks = vi.hoisted(() => ({
	signup: vi.fn(),
}));

vi.mock("../auth", () => ({
	auth: {
		useAuth: () => ({
			signup: mocks.signup,
			loading: false,
		}),
	},
}));

const { default: SignupPage } = await import("../pages/SignupPage");

function fillAndSubmit() {
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "Someone" },
	});
	fireEvent.change(screen.getByLabelText("Email"), {
		target: { value: "someone@example.com" },
	});
	fireEvent.change(screen.getByLabelText("Password"), {
		target: { value: "correct-horse-battery-staple" },
	});
	fireEvent.change(screen.getByLabelText("Confirm password"), {
		target: { value: "correct-horse-battery-staple" },
	});
	fireEvent.click(screen.getByRole("button", { name: /create account/i }));
}

beforeEach(() => {
	mocks.signup.mockReset();
	mocks.signup.mockResolvedValue(undefined);
});

describe("SignupPage", () => {
	it("sends the new account to the root once sign-up resolves", async () => {
		render(
			<MemoryRouter initialEntries={["/signup"]}>
				<Routes>
					<Route path="/signup" element={<SignupPage />} />
					<Route path="/" element={<p>root reached</p>} />
				</Routes>
			</MemoryRouter>,
		);
		fillAndSubmit();
		expect(await screen.findByText("root reached")).toBeDefined();
	});
});
