import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// auth and lessonsApi are the seams, matching machines-route.test.tsx.
// Everything between them - App's route table, the layout route, the Outlet
// context - stays real, so a route that stops nesting correctly fails here
// rather than in production. Mounting the real App is also what keeps this
// file from carrying a second copy of the route tree that could drift.
vi.mock("../auth", () => ({
	auth: {
		RequireAuth: ({ children }: { children: unknown }) => children,
		useAuth: () => ({
			user: { id: "u1", email: "someone@example.com" },
			logout: vi.fn(),
			refresh: vi.fn(),
			sessionExpiresAt: null,
			sessionExpiringSoon: false,
		}),
	},
}));

const mocks = vi.hoisted(() => ({
	listLessons: vi.fn(),
	getLesson: vi.fn(),
	setLessonStatus: vi.fn(),
}));

vi.mock("../api/lessonsApi", () => ({
	LESSON_ENDPOINTS: { lessons: "/api/lessons" },
	listLessons: mocks.listLessons,
	getLesson: mocks.getLesson,
	setLessonStatus: mocks.setLessonStatus,
}));

const { default: App } = await import("../App");

// Every field ZLesson demands, with identifiers that satisfy its regexes:
// ULID is Crockford base32 with I, L, O and U excluded; project_key is 12 hex
// characters and author_key is 32.
const VITE = {
	id: "01KZ45MKAM734ZS7JK24D2DK0R",
	schema_version: 2 as const,
	claim: "Vite 5 drops a top-level await in a worker entry",
	rationale: "esbuild lowers it to a promise the worker runtime never awaits.",
	evidence: {
		artifact_ids: ["01KZ45MKAM734ZS7JK24D2DK1A"],
		session_ids: ["sess-1"],
		project_key: "4c1de90ab372",
		observed_at: "2026-08-20T10:00:00.000Z",
		resolution: "Moved the await inside the fetch handler.",
	},
	applies_to: {
		stack: ["vite"],
		scope: { kind: "versioned" as const, versions: { vite: "<6" } },
		file_patterns: ["src/worker.ts"],
		task_kinds: ["build"],
	},
	visibility: "private" as const,
	consensus: { judges: 3, agreed: 3, decided_at: "2026-08-21T10:00:00.000Z" },
	status: "active" as const,
	superseded_by: null,
	source: "local" as const,
	author_key: "9f2c41ba7d5e08c3b6a1f470d2e95c8b",
	promoted_at: "2026-08-22T10:00:00.000Z",
};

const D1 = {
	...VITE,
	id: "01KZ45MKAM734ZS7JK24D2DK0S",
	claim: "D1 caps bound parameters at 100 per statement",
	promoted_at: "2026-08-23T10:00:00.000Z",
};

function withPool(lessons: unknown[], extra: Record<string, unknown> = {}) {
	mocks.listLessons.mockResolvedValue({
		lessons,
		cursor: null,
		has_more: false,
		...extra,
	});
}

async function at(path: string) {
	const result = render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);
	await waitFor(() => expect(mocks.listLessons).toHaveBeenCalled());
	return result;
}

beforeEach(() => {
	mocks.listLessons.mockReset();
	mocks.getLesson.mockReset();
	mocks.setLessonStatus.mockReset();
});

describe("the list pane", () => {
	it("renders inside the app shell", async () => {
		withPool([VITE]);
		await at("/lessons");
		expect(
			await screen.findByRole("navigation", { name: /sections/i }),
		).toBeDefined();
		await waitFor(() =>
			expect(
				screen
					.getByRole("link", { name: /lessons/i })
					.getAttribute("aria-current"),
			).toBe("page"),
		);
	});

	it("lists each lesson by its claim", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		expect(await screen.findByText(VITE.claim)).toBeDefined();
		expect(screen.getByText(D1.claim)).toBeDefined();
	});

	// One page, one request. The list returns full bodies precisely so that
	// clicking down the left column issues nothing; a second call here would
	// mean the page is refetching what it already holds.
	it("fetches exactly one page", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);
		expect(mocks.listLessons).toHaveBeenCalledTimes(1);
	});

	// An empty pool is the state at launch, so it says what to do about it and
	// links to the page where it can be done. A link, not a button - the
	// button in EmptyState is for Retry, and one that navigated would be a
	// control that looks like an action and is not.
	it("sends an empty pool to Machines", async () => {
		withPool([]);
		await at("/lessons");
		expect(
			await screen.findByRole("heading", { name: /nothing has synced yet/i }),
		).toBeDefined();
		expect(
			screen
				.getByRole("link", { name: /connect a machine/i })
				.getAttribute("href"),
		).toBe("/machines");
	});

	// The error state offers Retry and the empty state does not, because one
	// of them is worth trying again and the other is not.
	it("offers a retry when the pool cannot be read", async () => {
		mocks.listLessons.mockRejectedValueOnce(new Error("network is down"));
		await at("/lessons");
		expect(await screen.findByText(/network is down/i)).toBeDefined();

		withPool([VITE]);
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		expect(await screen.findByText(VITE.claim)).toBeDefined();
	});
});

describe("the detail pane", () => {
	// The whole reason the list returns full bodies. If this ever issues a
	// request, the in-memory read has quietly stopped working and every click
	// down the column costs a round-trip again.
	it("renders from memory without fetching", async () => {
		withPool([VITE, D1]);
		await at(`/lessons/${D1.id}`);
		expect(
			await screen.findByRole("heading", { name: D1.claim }),
		).toBeDefined();
		expect(mocks.getLesson).not.toHaveBeenCalled();
	});

	it("leads with the claim, then the rationale and what it applies to", async () => {
		withPool([VITE]);
		await at(`/lessons/${VITE.id}`);
		expect(
			await screen.findByRole("heading", { name: VITE.claim }),
		).toBeDefined();
		expect(screen.getByText(VITE.rationale)).toBeDefined();
		expect(screen.getByText("vite")).toBeDefined();
		expect(screen.getByText(/3 of 3/)).toBeDefined();
		expect(screen.getByText(VITE.evidence.resolution)).toBeDefined();
	});

	// A pasted link to a lesson outside the loaded pages. This is the one case
	// memory cannot answer, and the only reason GET /api/lessons/:id exists.
	it("fetches a lesson the loaded page does not hold", async () => {
		withPool([VITE]);
		mocks.getLesson.mockResolvedValue(D1);
		await at(`/lessons/${D1.id}`);
		expect(
			await screen.findByRole("heading", { name: D1.claim }),
		).toBeDefined();
		expect(mocks.getLesson).toHaveBeenCalledWith(D1.id);
	});

	// A deep link to an id nobody holds answers 404, and the pane says so
	// rather than sitting on a spinner forever.
	it("says so when the id resolves to nothing", async () => {
		withPool([VITE]);
		mocks.getLesson.mockRejectedValue(new Error("No such lesson"));
		await at("/lessons/01KZ45MKAM734ZS7JK24D2DK0T");
		expect(await screen.findByText(/no such lesson/i)).toBeDefined();
	});

	// Narrow shows one pane at a time, so the detail carries the only way back
	// to the list. The CSS hides it above the breakpoint, where the list is
	// already on screen.
	it("offers a way back to the list", async () => {
		withPool([VITE]);
		await at(`/lessons/${VITE.id}`);
		expect(
			(await screen.findByRole("link", { name: /all lessons/i })).getAttribute(
				"href",
			),
		).toBe("/lessons");
	});

	// The bug this guards: `lessons` is empty on the first render because the
	// pool has not loaded yet, and effects run child-first, so the detail asks
	// before the list has even started. Reading that emptiness as "not present"
	// fired a fallback fetch for every cold deep link to a lesson that was in
	// the pool all along.
	it("waits for the pool before deciding an id is absent", async () => {
		withPool([VITE]);
		await at(`/lessons/${VITE.id}`);
		expect(
			await screen.findByRole("heading", { name: VITE.claim }),
		).toBeDefined();
		expect(mocks.getLesson).not.toHaveBeenCalled();
	});

	// poolSettled is true even when the load failed, so a deep link still
	// resolves through GET /api/lessons/:id instead of hanging on a pool that
	// never arrived.
	it("still fetches a deep link when the pool itself failed to load", async () => {
		mocks.listLessons.mockRejectedValue(new Error("network is down"));
		mocks.getLesson.mockResolvedValue(D1);
		await at(`/lessons/${D1.id}`);
		expect(
			await screen.findByRole("heading", { name: D1.claim }),
		).toBeDefined();
		expect(mocks.getLesson).toHaveBeenCalledWith(D1.id);
	});

	// LessonDetail is not remounted when :id changes - same route element, same
	// position - so a fetch error from an absent id survives into the next
	// lesson unless something clears it. At >=60rem the list is on screen
	// beside the error, so this is one click away from a stale shared link.
	it("drops a fetch error once a lesson is in memory", async () => {
		withPool([VITE]);
		mocks.getLesson.mockRejectedValue(new Error("No such lesson"));
		await at("/lessons/01KZ45MKAM734ZS7JK24D2DK0T");
		expect(await screen.findByText(/no such lesson/i)).toBeDefined();

		// A RegExp, not the bare claim: getByRole's `name` option has no
		// `exact: false` - the row link's accessible name is the claim plus
		// its status badge and date, and only a RegExp does a partial match.
		fireEvent.click(screen.getByRole("link", { name: new RegExp(VITE.claim) }));

		expect(
			await screen.findByRole("heading", { name: VITE.claim }),
		).toBeDefined();
		expect(screen.queryByText(/no such lesson/i)).toBeNull();
	});

	// The plan's central premise: the list returns full bodies so that
	// clicking down the column reads from memory instead of round-tripping.
	// Every other test here renders at a fixed path with `at()`, so this is
	// the only one that clicks between two lessons in a single mount - the
	// only way this claim could actually be checked.
	it("does not refetch the pool when clicking from one lesson to another", async () => {
		withPool([VITE, D1]);
		await at(`/lessons/${VITE.id}`);
		expect(
			await screen.findByRole("heading", { name: VITE.claim }),
		).toBeDefined();
		expect(mocks.listLessons).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("link", { name: new RegExp(D1.claim) }));

		expect(
			await screen.findByRole("heading", { name: D1.claim }),
		).toBeDefined();
		expect(mocks.listLessons).toHaveBeenCalledTimes(1);
		expect(mocks.getLesson).not.toHaveBeenCalled();
	});
});
