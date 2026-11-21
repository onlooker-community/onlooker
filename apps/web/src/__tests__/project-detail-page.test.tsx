import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listProjects: vi.fn(),
	listLabels: vi.fn(),
	setLabel: vi.fn(),
	listMachines: vi.fn(),
	listSessions: vi.fn(),
	listLessons: vi.fn(),
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
	return { ...actual, listLabels: mocks.listLabels, setLabel: mocks.setLabel };
});
vi.mock("../api/machinesApi", () => ({
	MACHINE_ENDPOINTS: { machines: "/api/machines" },
	listMachines: mocks.listMachines,
}));
vi.mock("../api/sessionsApi", () => ({
	listSessions: mocks.listSessions,
}));
vi.mock("../api/lessonsApi", () => ({
	LESSON_ENDPOINTS: { lessons: "/api/lessons", activity: "/api/activity" },
	listLessons: mocks.listLessons,
}));

const { default: ProjectDetailPage } = await import(
	"../pages/ProjectDetailPage"
);
const { labelIdentity } = await import("../api/labelsApi");

const KEY = "a1b2c3d4e5f6";

const LAPTOP = {
	id: "m1",
	name: "work laptop",
	created_at: "2026-08-01T10:00:00.000Z",
	last_used_at: "2026-08-20T09:30:00.000Z",
	revoked_at: null,
	removed_at: null,
};

function project(overrides: Record<string, unknown> = {}) {
	return {
		project_key: KEY,
		basis: "remote",
		machine_id: null,
		sessions: 3,
		events: 120,
		last_seen_at: "2026-08-20T09:30:00.000Z",
		...overrides,
	};
}

function session(id: string) {
	return {
		machine_id: "m1",
		session_id: id,
		started_at: "2026-08-20T09:00:00.000Z",
		ended_at: "2026-08-20T09:38:00.000Z",
		prompts: 6,
		compactions: 0,
		counts_by_prefix: {},
		counts_by_type: {},
		counts_by_project: {},
	};
}

function lesson(id: string, claim: string, status = "active") {
	return { id, claim, status };
}

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/projects/:key" element={<ProjectDetailPage />} />
			</Routes>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.listProjects.mockResolvedValue({ projects: [project()] });
	mocks.listLabels.mockResolvedValue(new Map());
	mocks.listMachines.mockResolvedValue({ machines: [LAPTOP] });
	mocks.listSessions.mockResolvedValue({
		sessions: [session("s1")],
		cursor: null,
		has_more: false,
	});
	mocks.listLessons.mockResolvedValue({
		lessons: [lesson("l1", "Run the linter before committing")],
		cursor: null,
		has_more: false,
	});
});

describe("ProjectDetailPage", () => {
	it("opens with a sentence about the project", async () => {
		renderAt(`/projects/${KEY}`);

		const lead = await screen.findByTestId("project-headline");
		expect(lead.textContent).toContain("every machine");
		expect(lead.textContent).toContain("3 sessions");
		expect(lead.textContent).toContain("120 events");
	});

	it("asks for this project's sessions and lessons only", async () => {
		renderAt(`/projects/${KEY}`);

		await screen.findByTestId("project-headline");
		expect(mocks.listSessions).toHaveBeenCalledWith({
			limit: 8,
			project: [KEY],
		});
		expect(mocks.listLessons).toHaveBeenCalledWith({
			limit: 8,
			project: [KEY],
		});
	});

	it("scopes a root key's sessions to its machine", async () => {
		mocks.listProjects.mockResolvedValue({
			projects: [project({ basis: "root", machine_id: "m1" })],
		});
		renderAt(`/projects/${KEY}?machine=m1`);

		const lead = await screen.findByTestId("project-headline");
		expect(lead.textContent).toContain("work laptop only");
		expect(mocks.listSessions).toHaveBeenCalledWith({
			limit: 8,
			project: [`m1:${KEY}`],
		});
	});

	it("lists recent sessions and lessons, each linking onward", async () => {
		renderAt(`/projects/${KEY}`);

		const sessions = await screen.findByTestId("project-sessions");
		expect(within(sessions).getAllByRole("listitem")).toHaveLength(1);
		expect(within(sessions).getByText(/38m · 6 prompts/)).toBeTruthy();

		const lessons = await screen.findByTestId("project-lessons");
		const link = within(lessons).getByRole("link", {
			name: "Run the linter before committing",
		});
		expect(link.getAttribute("href")).toBe("/lessons/l1");
	});

	it("says so when nothing has reported yet", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [],
			cursor: null,
			has_more: false,
		});
		mocks.listLessons.mockResolvedValue({
			lessons: [],
			cursor: null,
			has_more: false,
		});
		renderAt(`/projects/${KEY}`);

		expect(
			await screen.findByText("No sessions have reported this project yet."),
		).toBeTruthy();
		expect(
			await screen.findByText("No lessons apply to this project yet."),
		).toBeTruthy();
	});

	it("keeps the page when the lessons cannot be read", async () => {
		mocks.listLessons.mockRejectedValue(new Error("offline"));
		renderAt(`/projects/${KEY}`);

		await screen.findByTestId("project-headline");
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByTestId("project-sessions")).toBeTruthy();
	});

	it("shows a name over its key", async () => {
		mocks.listLabels.mockResolvedValue(
			new Map([[labelIdentity(KEY, null), "api-server"]]),
		);
		renderAt(`/projects/${KEY}`);

		expect(await screen.findByText("api-server")).toBeTruthy();
		expect(screen.getByText(KEY)).toBeTruthy();
	});

	it("renames the project in place", async () => {
		mocks.setLabel.mockResolvedValue("api-server");
		renderAt(`/projects/${KEY}`);

		fireEvent.click(
			await screen.findByRole("button", { name: `Rename repository ${KEY}` }),
		);
		fireEvent.change(screen.getByRole("textbox", { name: `Name for ${KEY}` }), {
			target: { value: "api-server" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(screen.getByText("api-server")).toBeTruthy());
		expect(mocks.setLabel).toHaveBeenCalledWith(KEY, null, "api-server");
	});

	it("says so for a key that never reported", async () => {
		mocks.listProjects.mockResolvedValue({ projects: [] });
		renderAt(`/projects/${KEY}`);

		expect(await screen.findByText("No such project")).toBeTruthy();
		expect(screen.getByRole("link", { name: /all projects/i })).toBeTruthy();
	});

	it("says so when the projects cannot be loaded", async () => {
		mocks.listProjects.mockRejectedValue(new Error("offline"));
		renderAt(`/projects/${KEY}`);

		expect(await screen.findByText("Could not load this project")).toBeTruthy();
	});
});
