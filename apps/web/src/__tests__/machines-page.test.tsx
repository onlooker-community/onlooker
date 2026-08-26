import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// machinesApi is the seam, matching login-page.test.tsx: stubbing the three
// functions drives every failure path without standing up an API client, and
// leaves the form, the confirm flow and the reveal real.
const mocks = vi.hoisted(() => ({
	listMachines: vi.fn(),
	createMachine: vi.fn(),
	revokeMachine: vi.fn(),
}));

vi.mock("../api/machinesApi", () => ({
	MACHINE_ENDPOINTS: { machines: "/api/machines" },
	listMachines: mocks.listMachines,
	createMachine: mocks.createMachine,
	revokeMachine: mocks.revokeMachine,
}));

const { default: MachinesPage } = await import("../pages/MachinesPage");

const USED = {
	id: "m1",
	name: "work laptop",
	created_at: "2026-08-01T10:00:00.000Z",
	last_used_at: "2026-08-20T09:30:00.000Z",
	revoked_at: null,
};
const NEVER_USED = {
	id: "m2",
	name: "desktop",
	created_at: "2026-08-02T10:00:00.000Z",
	last_used_at: null,
	revoked_at: null,
};
const REVOKED = {
	id: "m3",
	name: "stolen laptop",
	created_at: "2026-08-03T10:00:00.000Z",
	last_used_at: "2026-08-04T10:00:00.000Z",
	revoked_at: "2026-08-05T10:00:00.000Z",
};

function withMachines(...machines: unknown[]) {
	mocks.listMachines.mockResolvedValue({ machines });
}

beforeEach(() => {
	mocks.listMachines.mockReset();
	mocks.createMachine.mockReset();
	mocks.revokeMachine.mockReset();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
		configurable: true,
	});
});

async function renderPage() {
	const result = render(<MachinesPage />);
	await waitFor(() => expect(mocks.listMachines).toHaveBeenCalled());
	return result;
}

describe("MachinesPage", () => {
	it("says how to recover a lost token when there are no machines", async () => {
		withMachines();
		await renderPage();
		// Recovery is revoke-and-mint-again and there is no other path, so the
		// empty state says it rather than leaving it to be discovered. Matched
		// on the actual sentence and not a bare "revoke" substring, which a
		// future Revoke button elsewhere on the page would also satisfy.
		const empty = await screen.findByText(/no machines yet/i);
		expect(empty).toBeDefined();
		expect(
			screen.getByText(/revoke its machine here and mint another/i),
		).toBeDefined();
	});

	it("lists machines by name", async () => {
		withMachines(USED, NEVER_USED);
		await renderPage();
		expect(await screen.findByText("work laptop")).toBeDefined();
		expect(screen.getByText("desktop")).toBeDefined();
	});

	// A dash in a column does not say "you minted this and never pointed a
	// plugin at it", which is the likeliest first-run failure in the product.
	it("renders never-used distinctly from a last-used timestamp", async () => {
		withMachines(USED, NEVER_USED);
		await renderPage();

		expect(await screen.findByText(/never used/i)).toBeDefined();
		// Asserted on the machine-readable attribute rather than the rendered
		// text, which is locale-dependent and would fail on another machine.
		const used = document.querySelector(`time[datetime="${USED.last_used_at}"]`);
		expect(used).not.toBeNull();
		// The Created column, unasserted until now - nothing here would have
		// failed if it were bound to last_used_at or revoked_at instead.
		const created = document.querySelector(`time[datetime="${USED.created_at}"]`);
		expect(created).not.toBeNull();
	});

	it("shows the token once and lets it go only on acknowledgement", async () => {
		withMachines();
		const token = `onlk_${"b".repeat(64)}`;
		mocks.createMachine.mockResolvedValue({ id: "m9", name: "new", token });
		await renderPage();

		fireEvent.change(screen.getByLabelText(/machine name/i), {
			target: { value: "new" },
		});
		fireEvent.click(screen.getByRole("button", { name: /mint token/i }));

		expect(await screen.findByText(token)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: /saved it/i }));
		await waitFor(() => expect(screen.queryByText(token)).toBeNull());
	});

	it("will not mint again while an unsaved token is on screen", async () => {
		withMachines();
		const token = `onlk_${"d".repeat(64)}`;
		mocks.createMachine.mockResolvedValue({ id: "m9", name: "first", token });
		await renderPage();

		fireEvent.change(screen.getByLabelText(/machine name/i), {
			target: { value: "first" },
		});
		fireEvent.click(screen.getByRole("button", { name: /mint token/i }));
		expect(await screen.findByText(token)).toBeDefined();

		// The modal covers the form and traps focus, so this should be
		// unreachable - but a second mint would replace a token nobody has
		// saved yet, and that loss cannot be undone.
		fireEvent.change(screen.getByLabelText(/machine name/i), {
			target: { value: "second" },
		});
		fireEvent.click(screen.getByRole("button", { name: /mint token/i }));

		expect(mocks.createMachine).toHaveBeenCalledTimes(1);
		expect(screen.getByText(token)).toBeDefined();
	});

	it("keeps the token on screen when the reload after minting fails", async () => {
		withMachines();
		const token = `onlk_${"c".repeat(64)}`;
		mocks.createMachine.mockResolvedValue({ id: "m9", name: "new", token });
		await renderPage();

		fireEvent.change(screen.getByLabelText(/machine name/i), {
			target: { value: "new" },
		});
		// The reload after a successful mint fails. Losing the only copy of the
		// token to a failed GET is the one unrecoverable failure this page can
		// produce, so it is pinned rather than reasoned about.
		mocks.listMachines.mockRejectedValue(new Error("Network unreachable"));
		fireEvent.click(screen.getByRole("button", { name: /mint token/i }));

		expect(await screen.findByText(token)).toBeDefined();
		expect(await screen.findByText(/network unreachable/i)).toBeDefined();
		// Still there after the failure surfaced, not swapped for an error state.
		expect(screen.getByText(token)).toBeDefined();
	});

	it("surfaces the API's own message when minting fails", async () => {
		withMachines();
		mocks.createMachine.mockRejectedValue(new Error("A machine needs a name"));
		await renderPage();
		const before = mocks.listMachines.mock.calls.length;

		fireEvent.change(screen.getByLabelText(/machine name/i), {
			target: { value: "   x" },
		});
		fireEvent.click(screen.getByRole("button", { name: /mint token/i }));

		// The API's sentence, not "Request failed with status 400" - the whole
		// point of #85.
		expect(await screen.findByText(/a machine needs a name/i)).toBeDefined();
		expect(screen.queryByRole("dialog")).toBeNull();
		// A request whose response never arrives can still have written the
		// machine. Reloading is what keeps that machine from being stranded,
		// unrevokable, in a list nothing ever refetches.
		await waitFor(() =>
			expect(mocks.listMachines.mock.calls.length).toBeGreaterThan(before),
		);
	});

	it("asks inline before revoking, and cancelling leaves the row alone", async () => {
		withMachines(USED);
		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		expect(screen.getByText(/revoke work laptop\?/i)).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		expect(mocks.revokeMachine).not.toHaveBeenCalled();
		expect(screen.getByText("work laptop")).toBeDefined();
	});

	it("revokes on confirmation and reloads the list", async () => {
		withMachines(USED);
		mocks.revokeMachine.mockResolvedValue({ success: true });
		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		const before = mocks.listMachines.mock.calls.length;
		mocks.listMachines.mockResolvedValue({
			machines: [{ ...USED, revoked_at: "2026-08-25T00:00:00.000Z" }],
		});
		fireEvent.click(screen.getByRole("button", { name: /yes, revoke/i }));

		await waitFor(() =>
			expect(mocks.revokeMachine).toHaveBeenCalledWith(USED.id),
		);
		// The row must come back from the server, not from a local mutation.
		// Without this, an optimistic implementation would pass unchanged.
		await waitFor(() =>
			expect(mocks.listMachines.mock.calls.length).toBeGreaterThan(before),
		);
		expect(await screen.findByText(/revoked/i)).toBeDefined();
	});

	// No optimistic update, so there is nothing to roll back - and nothing on
	// screen claiming a credential is dead while it is still live.
	it("leaves the row untouched when a revoke fails", async () => {
		withMachines(USED);
		mocks.revokeMachine.mockRejectedValue(new Error("No such machine"));
		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		fireEvent.click(screen.getByRole("button", { name: /yes, revoke/i }));

		expect(await screen.findByText(/no such machine/i)).toBeDefined();
		expect(screen.getByText("work laptop")).toBeDefined();
		expect(screen.queryByText(/^revoked$/i)).toBeNull();
	});

	it("keeps a revoked machine visible and gives it nothing to do", async () => {
		withMachines(REVOKED);
		await renderPage();
		expect(await screen.findByText("stolen laptop")).toBeDefined();
		expect(screen.queryByRole("button", { name: /^revoke$/i })).toBeNull();
	});

	it("offers a retry when the list cannot be loaded", async () => {
		mocks.listMachines.mockRejectedValue(new Error("Network unreachable"));
		await renderPage();

		expect(await screen.findByText(/network unreachable/i)).toBeDefined();
		withMachines(USED);
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		expect(await screen.findByText("work laptop")).toBeDefined();
	});
});
