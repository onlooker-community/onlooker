import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The three reads are the seams, matching machines-page.test.tsx. labelIdentity
// stays real: the page's lookup and this file's expectations must agree on it.
const mocks = vi.hoisted(() => ({
	listProjects: vi.fn(),
	listLabels: vi.fn(),
	setLabel: vi.fn(),
	listMachines: vi.fn(),
}));

vi.mock("../api/projectsApi", () => ({
	PROJECT_ENDPOINTS: { projects: "/api/projects" },
	listProjects: mocks.listProjects,
}));

vi.mock("../api/labelsApi", async () => {
	const actual =
		await vi.importActual<typeof import("../api/labelsApi")>(
			"../api/labelsApi",
		);
	return {
		...actual,
		listLabels: mocks.listLabels,
		setLabel: mocks.setLabel,
	};
});

vi.mock("../api/machinesApi", () => ({
	MACHINE_ENDPOINTS: { machines: "/api/machines" },
	listMachines: mocks.listMachines,
}));

const { default: ProjectsPage } = await import("../pages/ProjectsPage");
const { labelIdentity } = await import("../api/labelsApi");

const KEY_A = "a1b2c3d4e5f6";
const KEY_B = "0f1e2d3c4b5a";

const LAPTOP = {
	id: "m1",
	name: "work laptop",
	created_at: "2026-08-01T10:00:00.000Z",
	last_used_at: "2026-08-20T09:30:00.000Z",
	revoked_at: null,
	removed_at: null,
};
// Deleted from the Machines page, but the list still returns it, and its root
// keys still need a name.
const REMOVED = {
	...LAPTOP,
	id: "m2",
	name: "old desktop",
	removed_at: "2026-08-25T10:00:00.000Z",
};

function project(overrides: Record<string, unknown> = {}) {
	return {
		project_key: KEY_A,
		basis: "remote",
		machine_id: null,
		sessions: 3,
		events: 120,
		last_seen_at: "2026-08-20T09:30:00.000Z",
		...overrides,
	};
}

/** The project rows, past the table's header row. */
function rows() {
	return screen.getAllByRole("row").slice(1);
}

async function findRows() {
	return (await screen.findAllByRole("row")).slice(1);
}

beforeEach(() => {
	mocks.listProjects.mockReset();
	mocks.listLabels.mockReset();
	mocks.setLabel.mockReset();
	mocks.listMachines.mockReset();
	mocks.listProjects.mockResolvedValue({ projects: [project()] });
	mocks.listLabels.mockResolvedValue(new Map());
	mocks.listMachines.mockResolvedValue({ machines: [LAPTOP, REMOVED] });
});

describe("ProjectsPage", () => {
	it("shows an unnamed key with its sessions, events and last seen", async () => {
		render(<ProjectsPage />);

		const [row] = await findRows();
		expect(within(row).getByText(KEY_A)).toBeTruthy();
		expect(within(row).getByRole("cell", { name: "3" })).toBeTruthy();
		expect(within(row).getByRole("cell", { name: "120" })).toBeTruthy();
		expect(row.querySelector("time")).toBeTruthy();
	});

	it("gives each measure its own column", async () => {
		render(<ProjectsPage />);

		await findRows();
		expect(
			screen.getAllByRole("columnheader").map((th) => th.textContent),
		).toEqual(["Project", "Seen on", "Sessions", "Events", "Last seen"]);
		expect(within(rows()[0]).getAllByRole("cell")).toHaveLength(5);
	});

	it("marks a project never seen in a session", async () => {
		mocks.listProjects.mockResolvedValue({
			projects: [project({ sessions: 0, events: 0, last_seen_at: null })],
		});
		render(<ProjectsPage />);

		const [row] = await findRows();
		expect(within(row).getByRole("cell", { name: "—" })).toBeTruthy();
		expect(row.querySelector("time")).toBeNull();
	});

	it("shows a named key under its name, with the key still visible", async () => {
		mocks.listLabels.mockResolvedValue(
			new Map([[labelIdentity(KEY_A, null), "onlooker"]]),
		);
		render(<ProjectsPage />);

		const [row] = await findRows();
		expect(within(row).getByText("onlooker")).toBeTruthy();
		expect(within(row).getByText(KEY_A)).toBeTruthy();
	});

	it("lists two keys that share a name as two rows", async () => {
		mocks.listProjects.mockResolvedValue({
			projects: [project(), project({ project_key: KEY_B })],
		});
		mocks.listLabels.mockResolvedValue(
			new Map([
				[labelIdentity(KEY_A, null), "onlooker"],
				[labelIdentity(KEY_B, null), "onlooker"],
			]),
		);
		render(<ProjectsPage />);

		await findRows();
		expect(rows()).toHaveLength(2);
		expect(screen.getAllByText("onlooker")).toHaveLength(2);
	});

	it("says a remote key is on every machine and a root key on one", async () => {
		mocks.listProjects.mockResolvedValue({
			projects: [
				project(),
				project({ project_key: KEY_B, basis: "root", machine_id: "m1" }),
			],
		});
		render(<ProjectsPage />);

		const [remote, root] = await findRows();
		expect(within(remote).getByText("Every machine")).toBeTruthy();
		expect(within(root).getByText("work laptop only")).toBeTruthy();
	});

	it("says a key known only from a lesson was seen on one", async () => {
		mocks.listProjects.mockResolvedValue({
			projects: [project({ basis: null, sessions: 0, events: 0 })],
		});
		render(<ProjectsPage />);

		const [row] = await findRows();
		expect(within(row).getByText("Seen on a lesson")).toBeTruthy();
	});

	it("still names the machine behind a root key once it is removed", async () => {
		mocks.listProjects.mockResolvedValue({
			projects: [project({ basis: "root", machine_id: "m2" })],
		});
		render(<ProjectsPage />);

		const [row] = await findRows();
		expect(within(row).getByText("old desktop only")).toBeTruthy();
	});

	it("renames a remote key and shows the name the server stored", async () => {
		mocks.setLabel.mockResolvedValue("onlooker");
		render(<ProjectsPage />);

		await findRows();
		fireEvent.click(screen.getByRole("button", { name: /Rename repository/ }));
		fireEvent.change(screen.getByLabelText(`Name for ${KEY_A}`), {
			target: { value: " onlooker " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("onlooker")).toBeTruthy();
		expect(mocks.setLabel).toHaveBeenCalledWith(KEY_A, null, " onlooker ");
	});

	it("renames a root key under its machine", async () => {
		mocks.listProjects.mockResolvedValue({
			projects: [project({ basis: "root", machine_id: "m1" })],
		});
		mocks.setLabel.mockResolvedValue("scratch");
		render(<ProjectsPage />);

		await findRows();
		fireEvent.click(screen.getByRole("button", { name: /Rename repository/ }));
		fireEvent.change(screen.getByLabelText(`Name for ${KEY_A}`), {
			target: { value: "scratch" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("scratch")).toBeTruthy();
		expect(mocks.setLabel).toHaveBeenCalledWith(KEY_A, "m1", "scratch");
	});

	it("offers no rename until the names have arrived", async () => {
		let resolveLabels: (labels: Map<string, string>) => void = () => {};
		mocks.listLabels.mockReturnValue(
			new Promise((resolve) => {
				resolveLabels = resolve;
			}),
		);
		render(<ProjectsPage />);

		await waitFor(() => expect(mocks.listProjects).toHaveBeenCalled());
		expect(
			screen.queryByRole("button", { name: /Rename repository/ }),
		).toBeNull();

		resolveLabels(new Map([[labelIdentity(KEY_A, null), "onlooker"]]));

		expect(await screen.findByText("onlooker")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Rename repository/ }),
		).toBeTruthy();
	});

	it("still lists and renames keys when the names cannot be read", async () => {
		mocks.listLabels.mockRejectedValue(new Error("boom"));
		mocks.setLabel.mockResolvedValue("onlooker");
		render(<ProjectsPage />);

		const [row] = await findRows();
		expect(within(row).getByText(KEY_A)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /Rename repository/ }));
		fireEvent.change(screen.getByLabelText(`Name for ${KEY_A}`), {
			target: { value: "onlooker" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("onlooker")).toBeTruthy();
	});

	it("says one machine when the machines cannot be read", async () => {
		mocks.listMachines.mockRejectedValue(new Error("boom"));
		mocks.listProjects.mockResolvedValue({
			projects: [project({ basis: "root", machine_id: "m1" })],
		});
		render(<ProjectsPage />);

		const [row] = await findRows();
		expect(within(row).getByText("one machine only")).toBeTruthy();
	});

	it("closes one row's editor when another row's opens", async () => {
		mocks.listProjects.mockResolvedValue({
			projects: [project(), project({ project_key: KEY_B })],
		});
		render(<ProjectsPage />);

		await findRows();
		fireEvent.click(
			screen.getByRole("button", { name: `Rename repository ${KEY_A}` }),
		);
		expect(screen.getByLabelText(`Name for ${KEY_A}`)).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: `Rename repository ${KEY_B}` }),
		);

		expect(screen.queryByLabelText(`Name for ${KEY_A}`)).toBeNull();
		expect(screen.getByLabelText(`Name for ${KEY_B}`)).toBeTruthy();
	});

	it("says so when the projects cannot be loaded", async () => {
		mocks.listProjects.mockRejectedValue(new Error("boom"));
		render(<ProjectsPage />);

		await waitFor(() =>
			expect(screen.getByText("Could not load your projects")).toBeTruthy(),
		);
	});

	it("shows an empty state when there are no projects", async () => {
		mocks.listProjects.mockResolvedValue({ projects: [] });
		render(<ProjectsPage />);

		expect(await screen.findByText("No projects yet")).toBeTruthy();
	});
});
