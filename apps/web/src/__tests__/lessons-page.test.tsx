import { AuthApiError } from "@onlooker/auth-react";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
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

// What an unconfigured getLesson() call resolves to. Individual tests
// override this with their own mockResolvedValue/mockRejectedValue; this
// exists so a call a test did NOT expect fails on a wrong heading instead of
// throwing `.then` of `undefined` into the error boundary and hiding what
// actually broke.
const UNEXPECTED_FETCH = {
	...VITE,
	id: "01KZ45MKAM734ZS7JK24D2DK0V",
	claim: "getLesson should not have been called for this test",
};

beforeEach(() => {
	mocks.listLessons.mockReset();
	mocks.getLesson.mockReset();
	mocks.getLesson.mockResolvedValue(UNEXPECTED_FETCH);
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

describe("retract", () => {
	it("reflects the retraction in the detail and the row once the server agrees", async () => {
		withPool([VITE]);
		mocks.setLessonStatus.mockResolvedValue({ id: VITE.id, seq: 7 });
		await at(`/lessons/${VITE.id}`);

		fireEvent.click(await screen.findByRole("button", { name: /^retract$/i }));
		fireEvent.click(screen.getByRole("button", { name: /yes, retract/i }));

		await waitFor(() =>
			expect(mocks.setLessonStatus).toHaveBeenCalledWith(VITE.id, "retracted"),
		);
		// Two badges: the row in the list and the heading in the detail. Both
		// come from the same patched lesson, so both must move.
		await waitFor(() =>
			expect(
				screen.getAllByText("Retracted", { selector: ":not(option)" }).length,
			).toBe(2),
		);
	});

	// Nothing was marked retracted ahead of the server, so there is nothing to
	// roll back. A row that claimed a lesson was retracted while it was still
	// in force is worse than a slow button - the entire point of the action is
	// to stop trusting the claim.
	it("leaves the lesson untouched when the server refuses", async () => {
		withPool([VITE]);
		mocks.setLessonStatus.mockRejectedValue(new Error("Something went wrong"));
		await at(`/lessons/${VITE.id}`);

		fireEvent.click(await screen.findByRole("button", { name: /^retract$/i }));
		fireEvent.click(screen.getByRole("button", { name: /yes, retract/i }));

		expect(await screen.findByText(/something went wrong/i)).toBeDefined();
		expect(
			screen.queryByText("Retracted", { selector: ":not(option)" }),
		).toBeNull();
		expect(
			screen.getAllByText("Active", { selector: ":not(option)" }).length,
		).toBe(2);
	});

	// The API went out of its way to distinguish contention from a real
	// failure - "nothing was written, so retry" is a guarantee no other error
	// here makes. Flattening it into one generic message would discard that
	// distinction at the last step.
	it("says a sequence contention is worth retrying, and offers the retry", async () => {
		const contention = new AuthApiError(
			503,
			"sequence_contention",
			"Could not assign a lesson sequence; nothing was written, so retry",
		);
		withPool([VITE]);
		mocks.setLessonStatus.mockRejectedValueOnce(contention);
		await at(`/lessons/${VITE.id}`);

		fireEvent.click(await screen.findByRole("button", { name: /^retract$/i }));
		fireEvent.click(screen.getByRole("button", { name: /yes, retract/i }));

		expect(await screen.findByText(/nothing was written/i)).toBeDefined();

		mocks.setLessonStatus.mockResolvedValue({ id: VITE.id, seq: 8 });
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		await waitFor(() =>
			expect(
				screen.getAllByText("Retracted", { selector: ":not(option)" }).length,
			).toBe(2),
		);
	});

	// A 400 is not worth retrying and must not offer a button that would fail
	// the same way twice.
	it("offers no retry for a failure that would repeat", async () => {
		const refused = new AuthApiError(
			400,
			"status_not_allowed",
			"A lesson may be retracted or made active again from here.",
		);
		withPool([VITE]);
		mocks.setLessonStatus.mockRejectedValue(refused);
		await at(`/lessons/${VITE.id}`);

		fireEvent.click(await screen.findByRole("button", { name: /^retract$/i }));
		fireEvent.click(screen.getByRole("button", { name: /yes, retract/i }));

		expect(
			await screen.findByText(/may be retracted or made active/i),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
		// Not just the labeled retry: the primed destructive control itself
		// must not survive the failure either, or the page offers exactly the
		// one-click repeat it just said would fail again - only unlabeled.
		expect(screen.queryByRole("button", { name: /yes, retract/i })).toBeNull();
	});

	// A human may set retracted, and may set it back. Nothing else - and the
	// two buttons the UI renders are a convenience, not the enforcement.
	it("offers to restore a retracted lesson", async () => {
		withPool([{ ...VITE, status: "retracted" }]);
		mocks.setLessonStatus.mockResolvedValue({ id: VITE.id, seq: 9 });
		await at(`/lessons/${VITE.id}`);

		fireEvent.click(
			await screen.findByRole("button", { name: /make active/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: /yes, make active/i }));

		await waitFor(() =>
			expect(mocks.setLessonStatus).toHaveBeenCalledWith(VITE.id, "active"),
		);
	});

	// refuted belongs to the counter-observation that produced it and
	// superseded must name a replacement, so neither is a control this page
	// gets to render.
	it("offers nothing for a status the browser may not assert", async () => {
		withPool([{ ...VITE, status: "refuted" }]);
		await at(`/lessons/${VITE.id}`);
		await screen.findByRole("heading", { name: VITE.claim });
		expect(screen.queryByRole("button", { name: /retract/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /make active/i })).toBeNull();
	});

	// LessonDetail is reconciled in place when :id changes - same route
	// element, same position - so nothing here resets on its own unless
	// something clears it. Without that reset, a confirm armed on one lesson
	// stays armed under the next one the user opens, putting a live
	// "Yes, retract" over a claim nobody asked to retract.
	it("does not let an armed confirm follow the user to a different lesson", async () => {
		withPool([VITE, D1]);
		await at(`/lessons/${VITE.id}`);

		fireEvent.click(await screen.findByRole("button", { name: /^retract$/i }));
		expect(screen.getByRole("button", { name: /yes, retract/i })).toBeDefined();

		fireEvent.click(screen.getByRole("link", { name: new RegExp(D1.claim) }));
		await screen.findByRole("heading", { name: D1.claim });

		expect(screen.queryByRole("button", { name: /yes, retract/i })).toBeNull();
		expect(
			screen.queryByText(/stop trusting this lesson everywhere/i),
		).toBeNull();
		// No confirm is armed for D1, so there is nothing a stray click could
		// fire the PATCH from.
		expect(mocks.setLessonStatus).not.toHaveBeenCalled();
	});

	// Same root cause as the confirm above, for the error path: a failed
	// retract on one lesson must not leave its message, or its retry control,
	// attached to a lesson the user has since moved on to.
	it("does not let a failed retract's error follow the user to a different lesson", async () => {
		withPool([VITE, D1]);
		mocks.setLessonStatus.mockRejectedValueOnce(
			new Error("Something went wrong"),
		);
		await at(`/lessons/${VITE.id}`);

		fireEvent.click(await screen.findByRole("button", { name: /^retract$/i }));
		fireEvent.click(screen.getByRole("button", { name: /yes, retract/i }));
		expect(await screen.findByText(/something went wrong/i)).toBeDefined();

		fireEvent.click(screen.getByRole("link", { name: new RegExp(D1.claim) }));
		await screen.findByRole("heading", { name: D1.claim });

		expect(screen.queryByText(/something went wrong/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /yes, retract/i })).toBeNull();
	});

	// The async twin of the confirm test above: here the request is still in
	// flight - not yet settled - when the user navigates away, so nothing can
	// clear it on navigation because there is nothing to clear yet. The write
	// has to be refused when it lands instead.
	it("does not let a request in flight for one lesson write into the page for another once it settles", async () => {
		withPool([VITE, D1]);
		let reject: (error: unknown) => void = () => {};
		mocks.setLessonStatus.mockImplementationOnce(
			() =>
				new Promise((_, rej) => {
					reject = rej;
				}),
		);
		await at(`/lessons/${VITE.id}`);

		fireEvent.click(await screen.findByRole("button", { name: /^retract$/i }));
		fireEvent.click(screen.getByRole("button", { name: /yes, retract/i }));

		// Navigate to a different lesson while VITE's request is still
		// outstanding.
		fireEvent.click(screen.getByRole("link", { name: new RegExp(D1.claim) }));
		await screen.findByRole("heading", { name: D1.claim });

		// The request settles only now, after the user has moved on. Without
		// the guard this would paint VITE's error onto the page now showing
		// D1, and re-arm D1's button as no longer pending.
		await act(async () => {
			reject(new Error("Something went wrong"));
		});

		expect(screen.queryByText(/something went wrong/i)).toBeNull();
	});
});

describe("the status filter", () => {
	it("asks the server rather than filtering what it already has", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		withPool([]);
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "retracted" },
		});

		// Server-side, because a client-side filter would filter ONE loaded
		// page and call it the pool - wrong the moment a second page exists.
		await waitFor(() =>
			expect(mocks.listLessons).toHaveBeenLastCalledWith({
				statuses: ["retracted"],
			}),
		);
	});

	// The row that matters. An empty filter result saying "connect a machine"
	// would be a lie told to someone whose pool is full.
	it("says something different when a filter matches nothing", async () => {
		withPool([VITE]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		withPool([]);
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "retracted" },
		});

		expect(
			await screen.findByRole("heading", { name: /no retracted lessons/i }),
		).toBeDefined();
		expect(screen.queryByText(/nothing has synced yet/i)).toBeNull();
		expect(
			screen.queryByRole("link", { name: /connect a machine/i }),
		).toBeNull();
	});

	it("still says the pool is empty when no filter is set", async () => {
		withPool([]);
		await at("/lessons");
		expect(
			await screen.findByRole("heading", { name: /nothing has synced yet/i }),
		).toBeDefined();
		expect(screen.queryByText(/no retracted lessons/i)).toBeNull();
	});
});

describe("concurrent filter changes", () => {
	// The bug this guards: `load` had no way to tell which of several
	// in-flight requests was the newest, so whichever SETTLED last won,
	// rather than whichever was ASKED last - leaving the select reading one
	// status while the list showed rows for a different one.
	it("keeps the list in step with the last filter asked, not the last one to answer", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		let resolveFirst: (value: unknown) => void = () => {};
		mocks.listLessons.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		);
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "active" },
		});

		withPool([D1]);
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "retracted" },
		});
		await screen.findByText(D1.claim);

		// The stale "active" request answers now, after "retracted" already
		// rendered. Its result must lose regardless of arriving last.
		await act(async () => {
			resolveFirst({ lessons: [VITE], cursor: null, has_more: false });
		});

		expect(screen.queryByText(VITE.claim)).toBeNull();
		expect(screen.getByText(D1.claim)).toBeDefined();
	});

	// The rejection twin: a stale failure must not blank a list a newer
	// request already filled, or show an error nothing is waiting on anymore.
	it("does not let a stale rejection blank a list a newer request already filled", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		let rejectFirst: (error: unknown) => void = () => {};
		mocks.listLessons.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectFirst = reject;
				}),
		);
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "active" },
		});

		withPool([D1]);
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "retracted" },
		});
		await screen.findByText(D1.claim);

		await act(async () => {
			rejectFirst(new Error("network is down"));
		});

		expect(screen.getByText(D1.claim)).toBeDefined();
		expect(screen.queryByText(/network is down/i)).toBeNull();
		expect(
			screen.queryByRole("heading", { name: /could not load the pool/i }),
		).toBeNull();
	});

	// The narrower bug inside `finally`: guarding `lessons` is not enough,
	// because a stale settle's `finally` still runs. Unguarded, it would mark
	// the pool settled while the newest request is still in flight and
	// `lessons` is still empty - and the detail pane would read that as
	// "asked and absent" and fetch a lesson that is about to arrive in the
	// response already on its way.
	it("does not mark the pool settled from a stale request while the newest is still in flight", async () => {
		let resolveFirst: (value: unknown) => void = () => {};
		mocks.listLessons.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		);
		// Never settles for the rest of the test - the newest request has to
		// stay in flight for the precondition this guards against to hold.
		mocks.listLessons.mockImplementationOnce(() => new Promise(() => {}));

		render(
			<MemoryRouter initialEntries={[`/lessons/${D1.id}`]}>
				<App />
			</MemoryRouter>,
		);
		await waitFor(() => expect(mocks.listLessons).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "retracted" },
		});
		await waitFor(() => expect(mocks.listLessons).toHaveBeenCalledTimes(2));

		await act(async () => {
			resolveFirst({ lessons: [], cursor: null, has_more: false });
		});

		expect(mocks.getLesson).not.toHaveBeenCalled();
	});
});

describe("a failed filter refetch does not disturb the open lesson", () => {
	// The hazard the filter creates: load()'s catch sets lessons back to null,
	// which used to only happen on the very first load, when nothing was on
	// screen to lose. A filter change reaches it while a lesson is open -
	// `listed` goes null, poolSettled stays true, and without a fix the detail
	// pane would blank a lesson the user is reading and re-fetch one it
	// already had. The list query failing says nothing about the lesson on
	// screen.
	it("keeps showing the open lesson when the list vanishes under it", async () => {
		withPool([VITE, D1]);
		await at(`/lessons/${VITE.id}`);
		await screen.findByRole("heading", { name: VITE.claim });

		mocks.listLessons.mockRejectedValueOnce(new Error("network is down"));
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "retracted" },
		});

		await waitFor(() => expect(mocks.listLessons).toHaveBeenCalledTimes(2));
		expect(
			await screen.findByRole("heading", { name: VITE.claim }),
		).toBeDefined();
		expect(mocks.getLesson).not.toHaveBeenCalled();
	});
});
