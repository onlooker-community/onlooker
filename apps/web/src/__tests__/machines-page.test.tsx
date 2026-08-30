import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RevealHost, RevealProvider } from "../reveal";

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
// revoked_at and last_used_at are independently nullable columns - a machine
// minted and revoked before a plugin ever used it is a real state, not a
// hypothetical one.
const REVOKED_NEVER_USED = {
	id: "m4",
	name: "unused burner",
	created_at: "2026-08-06T10:00:00.000Z",
	last_used_at: null,
	revoked_at: "2026-08-07T10:00:00.000Z",
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
	const result = render(
		<RevealProvider>
			<MachinesPage />
			<RevealHost />
		</RevealProvider>,
	);
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

	// The markup was a table before the visual-language pass, with column and
	// row headers. The visible Created/Last used labels already recover what
	// the column headers did; what was lost is the boundary between machines
	// and the count. A screen reader currently hears one continuous run.
	it("exposes the machines as a list with one item per machine", async () => {
		withMachines(USED, NEVER_USED);
		await renderPage();
		const list = await screen.findByRole("list");
		expect(within(list).getAllByRole("listitem")).toHaveLength(2);
	});

	// A dash in a column does not say "you minted this and never pointed a
	// plugin at it", which is the likeliest first-run failure in the product.
	it("renders never-used distinctly from a last-used timestamp", async () => {
		withMachines(USED, NEVER_USED);
		await renderPage();

		expect(await screen.findByText(/never used/i)).toBeDefined();
		// Asserted on the machine-readable attribute rather than the rendered
		// text, which is locale-dependent and would fail on another machine.
		const used = document.querySelector(
			`time[datetime="${USED.last_used_at}"]`,
		);
		expect(used).not.toBeNull();
		// The Created column, unasserted until now - nothing here would have
		// failed if it were bound to last_used_at or revoked_at instead.
		const created = document.querySelector(
			`time[datetime="${USED.created_at}"]`,
		);
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
		// Exact match on the Chip's own text - a loose /revoked/i also matches
		// the "Revoked work laptop." status announcement now mounted on the
		// page, which is a different element making a different claim.
		expect(await screen.findByText("Revoked")).toBeDefined();
	});

	// A revoked machine keeps its row, but the ConfirmAction inside it returns
	// null once revoked_at is set - so the confirm button unmounts while
	// holding focus and the next Tab restarts at the top of the document. The
	// row is a stable target precisely because revoked rows persist.
	it("moves focus to the row after a revoke instead of dropping it", async () => {
		withMachines(USED);
		await renderPage();
		fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
		fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
		await waitFor(() => {
			expect(document.activeElement).not.toBe(document.body);
		});
		expect((document.activeElement as HTMLElement).dataset.machineRow).toBe(
			USED.id,
		);
	});

	// The live region is rendered on every pass, empty until it has something
	// to say. A region mounted together with its message is the shape screen
	// readers do not reliably announce.
	it("keeps a status region mounted before it has anything to announce", async () => {
		withMachines(USED);
		await renderPage();
		expect(screen.getByRole("status")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("");
	});

	it("names the machine it revoked", async () => {
		withMachines(USED);
		await renderPage();
		fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
		fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
		await waitFor(() => {
			expect(screen.getByRole("status").textContent).toMatch(
				new RegExp(USED.name, "i"),
			);
		});
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

	// The machine is still live, so there is nothing to announce and nowhere new
	// to stand: the confirm button the person is on is still there. Moving focus
	// or announcing a revoke here would both say the opposite of what happened.
	it("announces nothing and moves no focus when a revoke fails", async () => {
		withMachines(USED);
		mocks.revokeMachine.mockRejectedValue(new Error("No such machine"));
		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
		fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));

		expect(await screen.findByText(/no such machine/i)).toBeDefined();
		expect(screen.getByRole("status").textContent).toBe("");
		expect(
			(document.activeElement as HTMLElement | null)?.dataset.machineRow,
		).toBeUndefined();
	});

	// Revoking and reloading are two separate failures with opposite meanings.
	// Only a failed revoke means the credential is still live, and only it may
	// say so - telling someone a machine is still live when it is in fact
	// revoked sends them back to revoke it again.
	//
	// **If you are here because you changed `load`, this is why these broke.**
	// `revoke` wraps both `revokeMachine` and `load` in one try/catch whose
	// message is "Could not revoke that machine." That is safe today for one
	// reason only: `load` catches its own errors, sets `loadError`, and always
	// resolves, so a failed reload can never reach that catch. Make `load`
	// reject - or move the `await load()` out from under its own try - and a
	// successful revoke starts reporting itself as failed. Split the two
	// failures in `revoke` rather than relaxing this test.
	it("does not call a revoke failed when only the reload after it fails", async () => {
		withMachines(USED);
		mocks.revokeMachine.mockResolvedValue({ success: true });
		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		mocks.listMachines.mockRejectedValue(new Error("Network unreachable"));
		fireEvent.click(screen.getByRole("button", { name: /yes, revoke/i }));

		// The reload's own failure, with its own retry - not the revoke's.
		expect(await screen.findByText(/network unreachable/i)).toBeDefined();
		expect(screen.queryByText(/could not revoke that machine/i)).toBeNull();
		// The revoke landed, so it is still announced.
		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toMatch(
				new RegExp(USED.name, "i"),
			),
		);
	});

	// Same path, the focus half. A failed reload replaces the whole list with an
	// error state, so the row this would have focused unmounted with it and its
	// ref was deleted - the focus call found nothing and focus fell to <body>,
	// the exact defect Task 4 exists to prevent, one branch over.
	it("keeps focus in the page when the reload after a revoke fails", async () => {
		withMachines(USED);
		mocks.revokeMachine.mockResolvedValue({ success: true });
		await renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
		mocks.listMachines.mockRejectedValue(new Error("Network unreachable"));
		fireEvent.click(screen.getByRole("button", { name: /yes, revoke/i }));

		expect(await screen.findByText(/network unreachable/i)).toBeDefined();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("status")),
		);
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

	// Minting a token and never pointing a plugin at it is the likeliest first-run
	// failure in the product. A sleeping key says that faster than a word does -
	// and the word stays, because the icon alone would be a puzzle.
	it("marks a machine that has never been used with its own icon", async () => {
		withMachines(NEVER_USED);
		await renderPage();
		expect(await screen.findByText(/never used/i)).toBeDefined();
		// Array.from, not a bare spread: the project's `lib` has no
		// DOM.Iterable, so NodeListOf<Element> is not directly iterable under
		// this tsconfig.
		const icons = Array.from(document.querySelectorAll("img.pixel-icon"));
		expect(
			icons.some((i) => (i.getAttribute("src") ?? "").includes("Sleep")),
		).toBe(true);
	});

	it("renders every icon at a legal size", async () => {
		withMachines(USED, NEVER_USED, REVOKED);
		await renderPage();
		await screen.findByText(USED.name);
		const icons = Array.from(document.querySelectorAll("img.pixel-icon"));
		// Without this the loop below passes vacuously if nothing rendered.
		expect(icons.length).toBeGreaterThan(0);
		for (const img of icons) {
			expect(["16", "32", "48"]).toContain(img.getAttribute("width"));
		}
	});

	// A machine can be revoked before a plugin ever touches it - revoked_at and
	// last_used_at are independent columns. Pinning the choice: a dead
	// credential is the more important fact to lead with, so it keeps the Key
	// icon rather than switching to Sleep.
	it("prefers the revoked icon over the never-used icon when both apply", async () => {
		withMachines(REVOKED_NEVER_USED);
		await renderPage();
		expect(await screen.findByText(/never used/i)).toBeDefined();
		const icons = Array.from(document.querySelectorAll("img.pixel-icon"));
		expect(
			icons.some((i) => (i.getAttribute("src") ?? "").includes("Sleep")),
		).toBe(false);
		expect(
			icons.some((i) => (i.getAttribute("src") ?? "").includes("Key")),
		).toBe(true);
	});
});
