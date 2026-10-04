import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AcceptInvitePage from "../pages/AcceptInvitePage";

vi.mock("../api/orgsApi", () => ({
	verifyInvite: vi.fn(),
	acceptInvite: vi.fn(),
}));

const api = await import("../api/orgsApi");

const VALID = {
	valid: true,
	org: { id: "org-1", name: "Acme" },
	email: "carol@example.com",
	role: "member" as const,
};

function renderAt(routeToken: string) {
	return render(
		<MemoryRouter initialEntries={[`/orgs/invites/${routeToken}`]}>
			<Routes>
				<Route path="/orgs/invites/:token" element={<AcceptInvitePage />} />
			</Routes>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	vi.mocked(api.acceptInvite).mockResolvedValue({
		org_id: "org-1",
		role: "member",
	});
});

describe("AcceptInvitePage", () => {
	it("names the org for a valid invitation", async () => {
		vi.mocked(api.verifyInvite).mockResolvedValue(VALID);
		renderAt("good");
		expect(await screen.findByText(/Acme/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument();
	});

	it("gives one message for every unusable invitation", async () => {
		// The API deliberately does not distinguish unknown, expired and spent -
		// naming which is a hint to whoever is guessing - so the UI must not
		// invent a distinction it was never given.
		vi.mocked(api.verifyInvite).mockResolvedValue({ valid: false });
		renderAt("stale");
		expect(
			await screen.findByText(/no longer valid|cannot be used/i),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /accept/i }),
		).not.toBeInTheDocument();
	});

	it("accepts the invitation it was shown", async () => {
		vi.mocked(api.verifyInvite).mockResolvedValue(VALID);
		renderAt("good");
		await userEvent.click(
			await screen.findByRole("button", { name: /accept/i }),
		);
		expect(api.acceptInvite).toHaveBeenCalledWith("good");
	});

	it("explains a wrong-account refusal by naming the invited address", async () => {
		vi.mocked(api.verifyInvite).mockResolvedValue(VALID);
		vi.mocked(api.acceptInvite).mockRejectedValue(
			Object.assign(new Error("wrong_account"), {
				status: 403,
				code: "wrong_account",
			}),
		);
		renderAt("good");
		await userEvent.click(
			await screen.findByRole("button", { name: /accept/i }),
		);
		// Somebody who was forwarded a link needs to be told why it did not work.
		expect(await screen.findByText(/carol@example.com/)).toBeInTheDocument();
	});
});
