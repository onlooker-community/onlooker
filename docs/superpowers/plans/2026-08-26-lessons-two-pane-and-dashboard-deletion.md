# Lessons Two-Pane and the Dashboard Deletion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the lesson pool readable, judgeable and correctable from a browser at `/lessons`, and delete `/dashboard` in the same PR so `RequireAuth` always lands somewhere real.

**Architecture:** `/lessons` is a React Router layout route that fetches one page of the pool and holds it in state; `/lessons/:id` is a child route that renders its detail out of that in-memory list, falling back to `GET /api/lessons/:id` only when the id is not in a loaded page. One CSS breakpoint decides whether both panes show or the route picks one. Retract round-trips through `PATCH /api/lessons/:id/status` and reflects what the server said — never an optimistic update. The dashboard comes out last, in two halves: the web page and its links, then the endpoint, its contract cases, its mock branch and its types.

**Tech Stack:** React 18, react-router-dom 6 (`BrowserRouter`, not a data router), TypeScript, Vitest + @testing-library/react (jsdom), Cloudflare Workers + D1 for `apps/api`, `@onlooker/api-contract` as the shared drift gate.

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-08-23-lesson-pool-surface-design.md`, Sections 1, 3, 4, 5, 6, 7, plus the 2026-08-25 amendments. Bead: `onlooker-yfw`.
- **American English** in every comment, identifier, commit message and user-facing string: `color`, `behavior`, `normalize`, `canceled`, `analyze`.
- **Commits go through the `/commit` skill.** Format: `<type>(<scope>): <subject> :emoji:`, why-focused body, emoji reflecting *this* change. Every commit body in this plan ends with `Refs: onlooker-yfw`.
- **Branch and PR, never a direct push to `main`.** `main` has a ruleset the repo owner can bypass, so nothing mechanical will stop a mistake — it has to be a habit. `deploy.yml` fires on any push to `main` with `cancel-in-progress: true`, so a direct push can cancel an in-flight production deploy.
- **No optimistic updates on retract.** The button round-trips, shows pending, and renders what the server returned. A UI that shows a lesson retracted when it is not is worse than a slow button — the entire point of the action is to stop trusting a claim.
- **`useBlocker` is unavailable.** `main.tsx` mounts `BrowserRouter`, not `createBrowserRouter`. Do not reach for it.
- **Server-side rules are not re-implemented as client-side rules.** The browser may assert `active` and `retracted` only; `apps/api` enforces that with a 400. The UI renders only those two buttons *and* the server still rejects the rest. A rule that lives only in the client is not a rule.
- **Styling vocabulary:** inline styles reading `PALETTE` from `components/palette.ts`. A plate is a filled background and is constant across themes; an accent is ink on a ground and shifts. One key cannot be both — using a plate as text put links at 1.35 contrast once already.
- **Quality gates, run from the repo root:** `pnpm test`, `pnpm typecheck`, `pnpm lint`. Every task must leave all three green.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/web/src/api/lessonsApi.ts` | The three browser pool calls and the types they return. Beside `machinesApi.ts`, same shape: transport stays in `client.ts`. |
| `apps/web/src/pages/LessonsPage.tsx` | The layout route. Owns the fetched page, the status filter, the list pane, and the `Outlet` context the detail reads. |
| `apps/web/src/pages/LessonDetail.tsx` | The detail pane. Renders from the in-memory list, fetches on a deep link, and owns Retract. |
| `apps/web/src/pages/lessons.css` | The one breakpoint. Inline styles cannot express a media query, and this jsdom has no `window.matchMedia` at all — a `useMediaQuery` hook would throw in every test. |
| `apps/web/src/__tests__/lessons-page.test.tsx` | Everything the two panes do, driven through the real `App` route table so the test cannot drift from the routes. |

**Modified:**

| File | Change |
|---|---|
| `apps/web/package.json` | Add `@onlooker-community/lesson-contract` as a workspace dependency (type-only import, erased at build). |
| `apps/web/src/App.tsx` | Add the `/lessons` layout route with its `:id` child; later, delete the `/dashboard` route and its import. |
| `apps/web/src/pages/LoginPage.tsx` | `returnTo` falls back to `/lessons`. |
| `apps/web/src/pages/SignupPage.tsx` | `navigate("/lessons")`. |
| `apps/web/src/pages/HomePage.tsx`, `ProfilePage.tsx`, `SettingsPage.tsx`, `VerifyEmailPage.tsx` | Repoint their `/dashboard` links to `/lessons`. |
| `apps/web/src/__tests__/login-page.test.tsx` | The landing-route assertions move to `/lessons`. |
| `apps/web/src/types/api.ts` | Delete `DashboardData`, `DashboardStats`, `ActivityItem`. |
| `apps/web/src/api/types.ts` | Delete the two dashboard rows from the endpoint doc table. |
| `apps/web/src/api/mockApi.ts` | Delete the `/api/dashboard` branch and its `DashboardData` import. |
| `apps/web/src/api/mockResources.test.ts` | Delete the dashboard case and its import. |
| `apps/web/src/api/mock-base-url.test.ts` | Repoint the `/api/*`-routing proof off `/api/dashboard`. |
| `packages/api-contract/src/index.ts` | Delete the `dashboard, no token` and `dashboard, valid token` cases. Keep the incident narrative in the header comment. |
| `apps/api/src/router.ts` | Delete the `/api/dashboard` route entry and the `handleGetDashboard` import. |
| `apps/api/src/routes/data.ts` | Delete `handleGetDashboard` and the `DashboardData` import. |
| `apps/api/src/routes/index.ts` | Stop exporting `handleGetDashboard`. |
| `apps/api/src/types/responses.ts` | Delete the `DashboardData` interface. |
| `apps/api/src/index.ts` | Correct the WS4 header comment, which names dashboard data. |

**Deleted:** `apps/web/src/pages/DashboardPage.tsx`.

**Not touched:** `components/ui.tsx`, `components/palette.ts`, `components/AppShell.tsx`, `components/form.tsx`. They shipped in PR 3 with tests that already anticipate this page — `ui.test.tsx` names `"Nothing has synced yet"` and `"No retracted lessons"`, and `app-shell.test.tsx` already pins the `/lessons` href. Nothing here needs a new primitive.

---

## Notes for whoever builds this

**The spec undercounts the dashboard.** Section 1 says it "exists in five places." It exists in twenty-four, across three packages, and eight of those are `/dashboard` *route* links and redirects the spec does not mention at all — including `LoginPage`'s `returnTo` fallback and `SignupPage`'s post-signup `navigate`. Tasks 7 and 8 carry the full inventory. Do not trust the count in the spec; trust `grep -rn -i dashboard --include='*.ts' --include='*.tsx' apps packages`.

**The mock's pool is permanently empty and cannot be otherwise.** Lessons arrive by machine-authenticated push, which a browser cannot make, so `/api/lessons` in development always returns `{ lessons: [], cursor: null, has_more: false }`. This means the empty-pool state is the only state you can see by running `pnpm dev`, and every populated state is reachable only through the tests, which stub `lessonsApi` directly. That is a known gap, tracked as `onlooker-jws`; do not widen this task to fix it.

**`AuthApiError` carries `status`, `code`, `message` and `details`,** imported from `@onlooker/auth-react`. `describeError` in `lib/apiErrors.ts` returns `error.message` and nothing else, so the retryable-503 distinction in Task 4 has to read `.code` directly.

**`PATCH /api/lessons/:id/status` returns `{ id, seq }`, not the updated lesson.** The server also rewrites the lesson's `body.status` alongside the `status` column, in one `db.batch`, so setting the local copy's `status` to the value the server just accepted is reflecting the server's answer — not an optimistic guess about it.

---

### Task 1: `lessonsApi.ts` — the browser's read of the pool

**Files:**
- Create: `apps/web/src/api/lessonsApi.ts`
- Modify: `apps/web/package.json`
- Test: `apps/web/src/api/lessonsApi.test.ts`

**Interfaces:**
- Consumes: `apiClient` from `./client` (`get<T>`, `patch<T>`); `type TLesson`, `type TStatus` from `@onlooker-community/lesson-contract`.
- Produces: `LESSON_ENDPOINTS`, `type Lesson`, `type LessonStatus`, `type BrowserStatus`, `type LessonPage`, `type ListLessonsOptions`, `listLessons(options?)`, `getLesson(id)`, `setLessonStatus(id, status)`. Tasks 2–6 import all of these.

- [ ] **Step 1: Add the contract package as a web dependency**

`apps/web/package.json`, in `dependencies`, keeping the existing alphabetical drift as-is (the file already has `@onlooker/api-contract` last):

```json
		"@onlooker/api-contract": "workspace:*",
		"@onlooker-community/lesson-contract": "workspace:*"
```

Then, from the repo root:

```bash
pnpm install
```

This is a **type-only** import at every use site, so `zod` never reaches the browser bundle — `import type` is erased before esbuild sees it. The alternative was hand-mirroring `TLesson` into `lessonsApi.ts` the way `machinesApi.ts` mirrors `MachineTokenSummary`. That precedent does not transfer: `MachineTokenSummary` is an `apps/api` internal with no published definition, while `TLesson` *is* the published contract, and re-declaring it in the browser would be a second definition of the one thing this repo publishes a package to keep single.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/api/lessonsApi.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	patch: vi.fn(),
}));

vi.mock("./client", () => ({
	apiClient: { get: mocks.get, patch: mocks.patch },
}));

const { getLesson, listLessons, setLessonStatus } = await import("./lessonsApi");

beforeEach(() => {
	mocks.get.mockReset().mockResolvedValue({
		lessons: [],
		cursor: null,
		has_more: false,
	});
	mocks.patch.mockReset().mockResolvedValue({ id: "x", seq: 1 });
});

describe("listLessons", () => {
	it("asks for the bare path when it has no options", async () => {
		await listLessons();
		expect(mocks.get).toHaveBeenCalledWith("/api/lessons");
	});

	// Repeatable, not comma-joined. handleBrowseLessons reads
	// url.searchParams.getAll("status"), so "active,retracted" arrives as one
	// unknown status and comes back a 400.
	it("repeats status rather than joining it", async () => {
		await listLessons({ statuses: ["active", "retracted"] });
		expect(mocks.get).toHaveBeenCalledWith(
			"/api/lessons?status=active&status=retracted",
		);
	});

	// The cursor is base64 and can contain "+" and "=", both of which change
	// meaning in a query string. URLSearchParams encodes them; string
	// concatenation would not, and the server would reject a cursor it minted.
	it("encodes a cursor that carries base64 padding", async () => {
		await listLessons({ cursor: "YWJjKz0=" });
		expect(mocks.get).toHaveBeenCalledWith(
			"/api/lessons?cursor=YWJjKz0%3D",
		);
	});

	// apps/api guards with `if (opts.cursor)`, which treats "" as absent, and
	// the mock matches that. Sending `?cursor=` would be honest but noisy;
	// sending nothing is what both implementations already agree means "first
	// page".
	it("omits an empty cursor entirely", async () => {
		await listLessons({ cursor: "" });
		expect(mocks.get).toHaveBeenCalledWith("/api/lessons");
	});

	it("passes a limit through", async () => {
		await listLessons({ limit: 10 });
		expect(mocks.get).toHaveBeenCalledWith("/api/lessons?limit=10");
	});
});

describe("getLesson", () => {
	// An id reaches this straight from useParams, which is to say straight from
	// the URL bar. Encoding it is what keeps a pasted id containing a slash
	// from addressing a different route.
	it("encodes the id", async () => {
		mocks.get.mockResolvedValue({});
		await getLesson("a/b");
		expect(mocks.get).toHaveBeenCalledWith("/api/lessons/a%2Fb");
	});
});

describe("setLessonStatus", () => {
	it("patches the status sub-resource", async () => {
		await setLessonStatus("01KZ45MKAM734ZS7JK24D2DK0R", "retracted");
		expect(mocks.patch).toHaveBeenCalledWith(
			"/api/lessons/01KZ45MKAM734ZS7JK24D2DK0R/status",
			{ status: "retracted" },
		);
	});
});
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
pnpm --filter @onlooker/web exec vitest run src/api/lessonsApi.test.ts
```

Expected: FAIL — `Failed to resolve import "./lessonsApi"`.

- [ ] **Step 4: Write the implementation**

Create `apps/web/src/api/lessonsApi.ts`:

```ts
import type { TLesson, TStatus } from "@onlooker-community/lesson-contract";
import { apiClient } from "./client";

// The pool, as a person browses it. Beside machinesApi.ts and deliberately the
// same shape: transport - auth header, retries, refresh-and-replay on 401 -
// belongs to client.ts and is not re-implemented here.
//
// These are NOT the machine-authenticated /lessons routes. Those are delta-
// shaped: a sequence cursor, every status, built for a mirror draining a
// queue. Browsing is the opposite read, and the two are kept apart so a change
// made for a person cannot break a mirror mid-drain. See the design's
// Section 3 for why dual-authenticating one surface was rejected.

export const LESSON_ENDPOINTS = {
	lessons: "/api/lessons",
} as const;

/**
 * A lesson, as the contract package defines it and nowhere else.
 *
 * Imported rather than mirrored. machinesApi.ts declares its own `Machine`
 * because MachineTokenSummary is an apps/api internal with no published
 * definition; TLesson is the published contract, and a second copy of it in
 * the browser would be exactly the drift @onlooker-community/lesson-contract
 * exists to prevent. `import type` is erased at build, so zod does not reach
 * the bundle.
 */
export type Lesson = TLesson;

/** The four values the `status` column holds. */
export type LessonStatus = TStatus;

/**
 * The two a human may assert from a browser.
 *
 * `refuted` means a claim was tried and found false and belongs to the
 * counter-observation path that produces it - a click is not evidence.
 * `superseded` must name the lesson that replaced it, and the browser has no
 * authoring. apps/api rejects both with a 400 naming why; this type is a
 * convenience for callers, not the enforcement. A rule that lives only in the
 * client is not a rule.
 */
export type BrowserStatus = Extract<LessonStatus, "active" | "retracted">;

/** One page of the pool. Field names are the API's, not camelCased. */
export interface LessonPage {
	lessons: Lesson[];
	cursor: string | null;
	has_more: boolean;
}

export interface ListLessonsOptions {
	statuses?: LessonStatus[];
	cursor?: string | null;
	limit?: number;
}

export function listLessons(
	options: ListLessonsOptions = {},
): Promise<LessonPage> {
	const query = new URLSearchParams();

	// Appended once per status, not joined. handleBrowseLessons reads
	// searchParams.getAll("status"), so "active,retracted" would arrive as a
	// single unrecognized status and come back a 400.
	for (const status of options.statuses ?? []) query.append("status", status);

	// `if (cursor)` and not `!= null`: apps/api guards the same way, treating
	// "" as absent. Sending `?cursor=` for an empty string would be a request
	// neither implementation needs to answer.
	if (options.cursor) query.set("cursor", options.cursor);
	if (options.limit !== undefined) query.set("limit", String(options.limit));

	const search = query.toString();
	return apiClient.get<LessonPage>(
		search ? `${LESSON_ENDPOINTS.lessons}?${search}` : LESSON_ENDPOINTS.lessons,
	);
}

/**
 * One lesson by id, for the deep link the list cannot answer.
 *
 * The list returns full bodies, so clicking down the loaded pages issues no
 * requests at all. This exists for the one case that cannot work that way: an
 * id that is not in any page the browser has loaded.
 */
export function getLesson(id: string): Promise<Lesson> {
	return apiClient.get<Lesson>(
		`${LESSON_ENDPOINTS.lessons}/${encodeURIComponent(id)}`,
	);
}

/**
 * Move a lesson between `active` and `retracted`.
 *
 * Returns the feed sequence the transition was written at, not the updated
 * lesson - the same `transitionLesson` the machine route calls, which appends
 * to lesson_feed, so a retraction made here reaches every mirror on its next
 * delta pull with no new sync machinery.
 */
export function setLessonStatus(
	id: string,
	status: BrowserStatus,
): Promise<{ id: string; seq: number }> {
	return apiClient.patch<{ id: string; seq: number }>(
		`${LESSON_ENDPOINTS.lessons}/${encodeURIComponent(id)}/status`,
		{ status },
	);
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

```bash
pnpm --filter @onlooker/web exec vitest run src/api/lessonsApi.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Run the full gates**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green. If `typecheck` cannot resolve `@onlooker-community/lesson-contract`, run `pnpm build` once — the package publishes types from `dist/`, and `turbo`'s `typecheck` task depends on `^typecheck` rather than `^build`. `apps/api` already lives with this.

- [ ] **Step 7: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/api/lessonsApi.ts apps/web/src/api/lessonsApi.test.ts
```

Subject: `feat(web): give the browser a way to read the pool :books:`
Body: covers why the contract type is imported rather than mirrored, and why `status` repeats instead of joining. Ends with `Refs: onlooker-yfw`.

---

### Task 2: The list pane at `/lessons`

**Files:**
- Create: `apps/web/src/pages/LessonsPage.tsx`, `apps/web/src/pages/lessons.css`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Consumes: `listLessons`, `type Lesson`, `type LessonStatus` from `../api/lessonsApi`; `Panel`, `EmptyState`, `StatusBadge` from `../components/ui`; `PALETTE` from `../components/palette`; `describeError` from `../lib/apiErrors`.
- Produces: default export `LessonsPage`; named export `type LessonsContext = { lessons: Lesson[]; patchLesson: (id: string, status: LessonStatus) => void }`, which Task 3 reads through `useOutletContext`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/lessons-page.test.tsx`. This file grows through Tasks 3–6; start it with the fixtures and the list-pane cases.

```tsx
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
				screen.getByRole("link", { name: /lessons/i }).getAttribute("aria-current"),
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
			screen.getByRole("link", { name: /connect a machine/i }).getAttribute("href"),
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
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: FAIL — no `/lessons` route, so `App` renders `404 Not Found` and `listLessons` is never called; `waitFor` in `at()` times out.

- [ ] **Step 3: Write the breakpoint**

Create `apps/web/src/pages/lessons.css`:

```css
/*
 * The one breakpoint in the app.
 *
 * Inline styles cannot express a media query, and the alternative - a
 * useMediaQuery hook over window.matchMedia - is not available: the jsdom
 * this project tests against does not implement matchMedia at all, so such a
 * hook would throw in every test that renders this page.
 *
 * Narrow is the default and wide is the override, so the two panes are one
 * layout rather than two. Below the boundary the route picks the pane, via
 * data-pane; above it, both show and the override restores them. Vitest does
 * not process CSS, so nothing here applies under test - which is correct,
 * because what the tests assert is that both panes are in the document.
 */

.lessons-layout {
	display: grid;
	gap: 1.5rem;
	grid-template-columns: 1fr;
	align-items: start;
}

.lessons-layout[data-pane="detail"] > .lessons-list {
	display: none;
}

.lessons-layout[data-pane="list"] > .lessons-detail {
	display: none;
}

@media (min-width: 60rem) {
	.lessons-layout {
		grid-template-columns: minmax(18rem, 24rem) 1fr;
	}

	.lessons-layout > .lessons-list,
	.lessons-layout > .lessons-detail {
		display: block;
	}

	/* Redundant beside a list that is already on screen. */
	.lessons-back {
		display: none;
	}
}
```

- [ ] **Step 4: Write the page**

Create `apps/web/src/pages/LessonsPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useMatch } from "react-router-dom";
import {
	type Lesson,
	type LessonStatus,
	listLessons,
} from "../api/lessonsApi";
import { PALETTE } from "../components/palette";
import { EmptyState, Panel, StatusBadge } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import "./lessons.css";

// The pool, read by a person. A layout route rather than a page: it fetches
// one page of lessons and holds them, and /lessons/:id renders its detail out
// of that list through the Outlet context - so clicking down the left column
// issues no requests at all. The list returns full bodies for exactly this
// reason. See the design's Section 5.
//
// Selection is a ROUTE and not component state. Making it state would cost the
// back button, deep links, and any ability to paste someone a lesson. It is
// also what lets one breakpoint serve both widths: narrow shows the list at
// /lessons and the detail at /lessons/:id, rather than needing a second layout.

/** What the detail pane reads off the Outlet. */
export interface LessonsContext {
	lessons: Lesson[];
	/**
	 * Write a status the server has already accepted into the loaded page, so
	 * the row and the detail agree without a refetch. Not an optimistic
	 * update - the only caller runs it after the round-trip returns.
	 */
	patchLesson: (id: string, status: LessonStatus) => void;
}

const row = {
	display: "block",
	padding: "0.75rem",
	borderBottom: `2px solid ${PALETTE.border}`,
	textDecoration: "none",
	color: "var(--ink)",
};

/**
 * An instant, rendered so its value survives being read by a machine.
 * `toLocaleDateString` alone would make any assertion about it depend on the
 * runner's locale. Same call MachinesPage makes.
 */
function When({ iso }: { iso: string }) {
	return (
		<time dateTime={iso} style={{ color: PALETTE.muted, fontSize: "0.8rem" }}>
			{new Date(iso).toLocaleDateString()}
		</time>
	);
}

export default function LessonsPage() {
	const [lessons, setLessons] = useState<Lesson[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	// Which pane the narrow layout should show. The layout route does not
	// receive the child's params, so the path is matched directly.
	const detail = useMatch("/lessons/:id");

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const page = await listLessons();
			setLessons(page.lessons);
		} catch (error) {
			setLessons(null);
			setLoadError(describeError(error, "Could not load the pool."));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const patchLesson = useCallback((id: string, status: LessonStatus) => {
		setLessons((current) =>
			current === null
				? current
				: current.map((lesson) =>
						lesson.id === id ? { ...lesson, status } : lesson,
					),
		);
	}, []);

	const context: LessonsContext = { lessons: lessons ?? [], patchLesson };

	return (
		<div className="lessons-layout" data-pane={detail ? "detail" : "list"}>
			<div className="lessons-list">
				{loadError ? (
					<EmptyState
						title="Could not load the pool"
						action={{ label: "Retry", onClick: () => void load() }}
					>
						{loadError}
					</EmptyState>
				) : lessons === null ? (
					<p style={{ color: PALETTE.muted }}>Loading the pool...</p>
				) : lessons.length === 0 ? (
					<EmptyState title="Nothing has synced yet">
						Lessons arrive when a machine pushes them.{" "}
						{/*
						  A link and not EmptyState's action button. The button
						  is for Retry; one that navigated would read as an
						  action and be a link wearing the wrong control.
						*/}
						<NavLink to="/machines" style={{ color: PALETTE.accent }}>
							Connect a machine
						</NavLink>{" "}
						to start.
					</EmptyState>
				) : (
					<Panel title="The pool">
						<nav aria-label="Lessons">
							{lessons.map((lesson) => (
								// NavLink, not Link: it sets aria-current="page" on the
								// selected one, which is the only thing telling a screen
								// reader which row the detail pane is showing.
								<NavLink
									key={lesson.id}
									to={`/lessons/${lesson.id}`}
									style={({ isActive }) => ({
										...row,
										background: isActive ? "var(--panel)" : "transparent",
										borderLeft: isActive
											? `4px solid ${PALETTE.accent}`
											: "4px solid transparent",
									})}
								>
									<span style={{ display: "block", marginBottom: "0.35rem" }}>
										{lesson.claim}
									</span>
									<span
										style={{
											display: "flex",
											gap: "0.5rem",
											alignItems: "center",
										}}
									>
										<StatusBadge status={lesson.status} />
										<When iso={lesson.promoted_at} />
									</span>
								</NavLink>
							))}
						</nav>
					</Panel>
				)}
			</div>

			<div className="lessons-detail">
				{detail ? (
					<Outlet context={context} />
				) : (
					<Panel>
						<p style={{ margin: 0, color: PALETTE.muted }}>
							Select a lesson to read its rationale and evidence.
						</p>
					</Panel>
				)}
			</div>
		</div>
	);
}
```

- [ ] **Step 5: Mount the route**

In `apps/web/src/App.tsx`, add the import beside the others:

```tsx
import LessonsPage from "./pages/LessonsPage";
```

Then add the route immediately before the `/machines` route, and delete the stale comment above `/machines` that says the Lessons link goes nowhere — it goes somewhere now:

```tsx
				{/*
				  A layout route. LessonsPage fetches one page and renders the
				  list; the :id child renders its detail out of that same
				  in-memory list through the Outlet context, so clicking a row
				  issues no request. Deep links fall back to GET
				  /api/lessons/:id, which is the one case memory cannot answer.
				*/}
				<Route
					path="/lessons"
					element={
						<auth.RequireAuth>
							<AppShell>
								<LessonsPage />
							</AppShell>
						</auth.RequireAuth>
					}
				/>
				<Route
					path="/machines"
					element={
						<auth.RequireAuth>
							<AppShell>
								<MachinesPage />
							</AppShell>
						</auth.RequireAuth>
					}
				/>
```

The `:id` child route lands in Task 3; this task mounts the parent alone, so the list renders and the detail pane shows its prompt.

- [ ] **Step 6: Run the tests and make sure they pass**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Run the full gates**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green. `app-shell.test.tsx`'s `href(/lessons/i)` assertion has been passing since PR 3 and still does.

- [ ] **Step 8: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/src/pages/LessonsPage.tsx apps/web/src/pages/lessons.css apps/web/src/App.tsx apps/web/src/__tests__/lessons-page.test.tsx
```

Subject: `feat(web): put the pool on a page :bookmark_tabs:`
Body: why selection is a route rather than state, and why one CSS file exists in a codebase of inline styles. Ends with `Refs: onlooker-yfw`.

---

### Task 3: The detail pane, from memory and from a deep link

**Files:**
- Create: `apps/web/src/pages/LessonDetail.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Consumes: `type LessonsContext` from `./LessonsPage`; `getLesson`, `type Lesson` from `../api/lessonsApi`; `Chip`, `EmptyState`, `Panel`, `StatusBadge` from `../components/ui`; `PALETTE`; `describeError`.
- Produces: default export `LessonDetail`. Task 4 adds Retract to this same file.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/__tests__/lessons-page.test.tsx`:

```tsx
describe("the detail pane", () => {
	// The whole reason the list returns full bodies. If this ever issues a
	// request, the in-memory read has quietly stopped working and every click
	// down the column costs a round-trip again.
	it("renders from memory without fetching", async () => {
		withPool([VITE, D1]);
		await at(`/lessons/${D1.id}`);
		expect(await screen.findByRole("heading", { name: D1.claim })).toBeDefined();
		expect(mocks.getLesson).not.toHaveBeenCalled();
	});

	it("leads with the claim, then the rationale and what it applies to", async () => {
		withPool([VITE]);
		await at(`/lessons/${VITE.id}`);
		expect(await screen.findByRole("heading", { name: VITE.claim })).toBeDefined();
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
		expect(await screen.findByRole("heading", { name: D1.claim })).toBeDefined();
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
});
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: FAIL — `/lessons/:id` has no child route, so `data-pane` is `"detail"` but `<Outlet/>` renders nothing and no heading appears.

- [ ] **Step 3: Write the detail pane**

Create `apps/web/src/pages/LessonDetail.tsx`:

```tsx
import { type ReactNode, useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { getLesson, type Lesson } from "../api/lessonsApi";
import { PALETTE } from "../components/palette";
import { Chip, EmptyState, Panel, StatusBadge } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import type { LessonsContext } from "./LessonsPage";

// One lesson, read in full. Rendered out of the list LessonsPage already
// holds, because the list returns full bodies - so clicking down the column
// issues nothing. GET /api/lessons/:id is the fallback for the one case that
// cannot work that way: an id not in any loaded page, which is what a pasted
// link is.

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div style={{ marginBottom: "1rem" }}>
			<h3
				style={{
					margin: "0 0 0.35rem",
					fontFamily: "var(--font-display)",
					fontSize: "12px",
					letterSpacing: "1px",
					textTransform: "uppercase",
					color: PALETTE.muted,
				}}
			>
				{label}
			</h3>
			{children}
		</div>
	);
}

function Chips({ values }: { values: string[] }) {
	return (
		<div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
			{values.map((value) => (
				<Chip key={value}>{value}</Chip>
			))}
		</div>
	);
}

export default function LessonDetail() {
	const { id } = useParams();
	const { lessons } = useOutletContext<LessonsContext>();

	// The loaded page is the source of truth whenever it holds this id, so a
	// retraction written into it by patchLesson shows here without a refetch.
	const listed = lessons.find((lesson) => lesson.id === id) ?? null;

	const [fetched, setFetched] = useState<Lesson | null>(null);
	const [fetchError, setFetchError] = useState<string | null>(null);

	useEffect(() => {
		// Nothing to do while the id is in memory. This is the branch that
		// keeps clicking down the list free.
		if (!id || listed) return;

		let live = true;
		setFetchError(null);
		getLesson(id)
			.then((lesson) => {
				if (live) setFetched(lesson);
			})
			.catch((error) => {
				if (live) setFetchError(describeError(error, "Could not load that lesson."));
			});

		// The list pane stays mounted while the detail changes, so a slow
		// response for a lesson the user has already navigated away from would
		// otherwise overwrite the one they are looking at.
		return () => {
			live = false;
		};
	}, [id, listed]);

	const lesson = listed ?? (fetched?.id === id ? fetched : null);

	const back = (
		// Narrow shows one pane at a time, so this is the only way back to the
		// list. lessons.css hides it above the breakpoint, where the list is
		// already beside it.
		<Link className="lessons-back" to="/lessons" style={{ color: PALETTE.accent }}>
			← All lessons
		</Link>
	);

	if (fetchError) {
		return (
			<>
				{back}
				<EmptyState title="Could not load that lesson">{fetchError}</EmptyState>
			</>
		);
	}

	if (!lesson) {
		return (
			<>
				{back}
				<p style={{ color: PALETTE.muted }}>Loading that lesson...</p>
			</>
		);
	}

	const { applies_to: appliesTo, consensus, evidence } = lesson;

	return (
		<>
			{back}
			<Panel>
				{/*
				  The claim leads, because it is the thing being trusted or
				  not. Everything below it exists to justify or qualify it.
				*/}
				<h1 style={{ marginTop: "0.5rem", fontSize: "1.25rem" }}>{lesson.claim}</h1>
				<div
					style={{
						display: "flex",
						gap: "0.5rem",
						alignItems: "center",
						marginBottom: "1.25rem",
					}}
				>
					<StatusBadge status={lesson.status} />
					<time dateTime={lesson.promoted_at} style={{ color: PALETTE.muted }}>
						Promoted {new Date(lesson.promoted_at).toLocaleDateString()}
					</time>
				</div>

				<Field label="Rationale">
					<p style={{ margin: 0 }}>{lesson.rationale}</p>
				</Field>

				<Field label="Stack">
					<Chips values={appliesTo.stack} />
				</Field>

				<Field label="Scope">
					{appliesTo.scope.kind === "versioned" ? (
						<Chips
							values={Object.entries(appliesTo.scope.versions).map(
								([name, range]) => `${name} ${range}`,
							)}
						/>
					) : (
						// The justification is the point of this branch: a lesson
						// with no version constraint never expires, so the reason
						// is judged rather than assumed.
						<p style={{ margin: 0 }}>{appliesTo.scope.justification}</p>
					)}
				</Field>

				{appliesTo.file_patterns.length > 0 ? (
					<Field label="Files">
						<Chips values={appliesTo.file_patterns} />
					</Field>
				) : null}

				{appliesTo.task_kinds.length > 0 ? (
					<Field label="Tasks">
						<Chips values={appliesTo.task_kinds} />
					</Field>
				) : null}

				<Field label="Consensus">
					<p style={{ margin: 0 }}>
						{consensus.agreed} of {consensus.judges} judges agreed on{" "}
						<time dateTime={consensus.decided_at}>
							{new Date(consensus.decided_at).toLocaleDateString()}
						</time>
					</p>
				</Field>

				<Field label="What was observed">
					<p style={{ margin: 0 }}>{evidence.resolution}</p>
					<p style={{ margin: "0.35rem 0 0", color: PALETTE.muted }}>
						<time dateTime={evidence.observed_at}>
							{new Date(evidence.observed_at).toLocaleDateString()}
						</time>
						{" · "}
						{evidence.session_ids.length} session
						{evidence.session_ids.length === 1 ? "" : "s"}
						{" · "}
						{evidence.artifact_ids.length} artifact
						{evidence.artifact_ids.length === 1 ? "" : "s"}
					</p>
				</Field>

				<Field label="Provenance">
					{/*
					  project_key and author_key are opaque by design - the
					  mapping to a repository lives only in a local manifest,
					  and author_key carries the unlinkability guarantee. They
					  are shown because they are what a person correlates two
					  lessons by, not because they mean anything on their own.
					*/}
					<Chips
						values={[
							`source: ${lesson.source}`,
							`visibility: ${lesson.visibility}`,
							`project: ${evidence.project_key}`,
						]}
					/>
				</Field>
			</Panel>
		</>
	);
}
```

- [ ] **Step 4: Nest the child route**

In `apps/web/src/App.tsx`, add the import:

```tsx
import LessonDetail from "./pages/LessonDetail";
```

and turn the `/lessons` route into a parent with a child:

```tsx
				<Route
					path="/lessons"
					element={
						<auth.RequireAuth>
							<AppShell>
								<LessonsPage />
							</AppShell>
						</auth.RequireAuth>
					}
				>
					<Route path=":id" element={<LessonDetail />} />
				</Route>
```

- [ ] **Step 5: Run the tests and make sure they pass**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: PASS, 10 tests.

- [ ] **Step 6: Run the full gates**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green.

- [ ] **Step 7: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/src/pages/LessonDetail.tsx apps/web/src/App.tsx apps/web/src/__tests__/lessons-page.test.tsx
```

Subject: `feat(web): read a lesson without asking for it twice :mag:`
Body: why the detail reads from the loaded page and what the deep-link fallback is for; why the fetch effect guards against a stale response. Ends with `Refs: onlooker-yfw`.

---

### Task 4: Retract, and the 503 that says it is worth retrying

**Files:**
- Modify: `apps/web/src/pages/LessonDetail.tsx`, `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Consumes: `setLessonStatus`, `type BrowserStatus` from `../api/lessonsApi`; `patchLesson` off `LessonsContext`; `Button` from `../components/ui`; `AuthApiError` from `@onlooker/auth-react`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/__tests__/lessons-page.test.tsx`. Add the error class to the imports at the top of the file — a real `AuthApiError` and not a hand-shaped object, because `LessonDetail` narrows on `instanceof` and a look-alike would let that check rot without the test noticing:

```tsx
import { AuthApiError } from "@onlooker/auth-react";
```

```tsx
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
			expect(screen.getAllByText("Retracted").length).toBe(2),
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
		expect(screen.queryByText("Retracted")).toBeNull();
		expect(screen.getAllByText("Active").length).toBe(2);
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
			expect(screen.getAllByText("Retracted").length).toBe(2),
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

		expect(await screen.findByText(/may be retracted or made active/i)).toBeDefined();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	// A human may set retracted, and may set it back. Nothing else - and the
	// two buttons the UI renders are a convenience, not the enforcement.
	it("offers to restore a retracted lesson", async () => {
		withPool([{ ...VITE, status: "retracted" }]);
		mocks.setLessonStatus.mockResolvedValue({ id: VITE.id, seq: 9 });
		await at(`/lessons/${VITE.id}`);

		fireEvent.click(await screen.findByRole("button", { name: /make active/i }));
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
});
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: FAIL — `Unable to find an accessible element with the role "button" and name /^retract$/i`.

- [ ] **Step 3: Add the transition to `LessonDetail.tsx`**

Extend the imports:

```tsx
import { AuthApiError } from "@onlooker/auth-react";
import {
	type BrowserStatus,
	getLesson,
	type Lesson,
	setLessonStatus,
} from "../api/lessonsApi";
import { Button, Chip, EmptyState, Panel, StatusBadge } from "../components/ui";
```

Read `patchLesson` off the context:

```tsx
	const { lessons, patchLesson } = useOutletContext<LessonsContext>();
```

Add the transition state beside the fetch state:

```tsx
	const [confirming, setConfirming] = useState(false);
	const [pending, setPending] = useState(false);
	const [actionError, setActionError] = useState<
		{ message: string; retryable: boolean } | null
	>(null);
```

Add the handler above the `back` link:

```tsx
	const transition = async (next: BrowserStatus) => {
		if (!id || pending) return;
		setPending(true);
		setActionError(null);
		try {
			await setLessonStatus(id, next);
			// AFTER the round-trip, never before. The server returns { id, seq }
			// rather than the lesson, but it wrote body.status and the status
			// column together in one batch - so writing the status it just
			// accepted is reflecting its answer, not guessing at it.
			patchLesson(id, next);
			setFetched((current) =>
				current && current.id === id ? { ...current, status: next } : current,
			);
			setConfirming(false);
		} catch (error) {
			// transitionLesson can exhaust its sequence retries, which apps/api
			// turns into a 503 whose message says nothing was written. That is a
			// guarantee no other failure here makes, and it is the difference
			// between "press it again" and "do not". Read off `code` rather than
			// the message, because describeError only carries the text.
			const retryable =
				error instanceof AuthApiError && error.code === "sequence_contention";
			setActionError({
				message: describeError(error, "Could not change that lesson's status."),
				retryable,
			});
		} finally {
			setPending(false);
		}
	};
```

Derive the transition beside the existing destructure, so the JSX below stays flat — `lesson` is already known non-null there, the `!lesson` guard having returned:

```tsx
	const { applies_to: appliesTo, consensus, evidence } = lesson;

	// A retracted lesson can be made active again; an active one can be
	// retracted. Those are the only two a human may assert - and apps/api
	// enforces that with a 400 regardless of what this renders. `null` for the
	// other two statuses, which get no control at all.
	const next: BrowserStatus | null =
		lesson.status === "active"
			? "retracted"
			: lesson.status === "retracted"
				? "active"
				: null;
	const verb = next === "retracted" ? "Retract" : "Make active";
```

Add the control block just before the closing `</Panel>`, after the Provenance field:

```tsx
				{next ? (
					<div style={{ marginTop: "1.5rem" }}>
						{confirming ? (
							<div
								style={{
									display: "flex",
									gap: "0.5rem",
									alignItems: "center",
									flexWrap: "wrap",
								}}
							>
								{/*
								  Inline rather than window.confirm, matching
								  MachinesPage. Retraction reaches every mirror on
								  its next delta pull, so it is the most
								  consequential act on this page and should not be
								  handed to a native dialog that looks like nothing
								  else in the app.
								*/}
								<span>
									{next === "retracted"
										? "Stop trusting this lesson everywhere?"
										: "Trust this lesson again everywhere?"}
								</span>
								<Button
									variant={next === "retracted" ? "danger" : "primary"}
									loading={pending}
									loadingLabel="Working..."
									onClick={() => void transition(next)}
								>
									Yes, {verb.toLowerCase()}
								</Button>
								<Button onClick={() => setConfirming(false)} disabled={pending}>
									Cancel
								</Button>
							</div>
						) : (
							<Button
								variant={next === "retracted" ? "danger" : "primary"}
								onClick={() => {
									setActionError(null);
									setConfirming(true);
								}}
							>
								{verb}
							</Button>
						)}

						{actionError ? (
							<div role="alert" style={{ marginTop: "0.75rem" }}>
								<p style={{ color: PALETTE.danger, margin: "0 0 0.5rem" }}>
									{actionError.message}
								</p>
								{/*
								  Offered only where the server promised nothing was
								  written. A 400 would fail identically on a second
								  press, and a button that reliably fails is worse
								  than no button.
								*/}
								{actionError.retryable ? (
									<Button
										loading={pending}
										loadingLabel="Working..."
										onClick={() => void transition(next)}
									>
										Try again
									</Button>
								) : null}
							</div>
						) : null}
					</div>
				) : null}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Run the full gates**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green.

- [ ] **Step 6: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/src/pages/LessonDetail.tsx apps/web/src/__tests__/lessons-page.test.tsx
```

Subject: `feat(web): let a person stop trusting a lesson :no_entry:`
Body: why the update waits for the round-trip, and why `sequence_contention` keeps its own treatment instead of collapsing into a generic failure. Ends with `Refs: onlooker-yfw`.

---

### Task 5: The status filter, and the empty state that does not lie

**Files:**
- Modify: `apps/web/src/pages/LessonsPage.tsx`, `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Consumes: `listLessons` with `{ statuses }`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/__tests__/lessons-page.test.tsx`:

```tsx
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
		expect(screen.queryByRole("link", { name: /connect a machine/i })).toBeNull();
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
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: FAIL — `Unable to find a label with the text of: /status/i`.

- [ ] **Step 3: Add the filter to `LessonsPage.tsx`**

Add the option table above the component:

```tsx
/**
 * Status filtering ships; stack filtering does not.
 *
 * Not a matter of effort. `status` is a real column with a real index, so the
 * server can answer it across the whole pool. Stack lives inside the JSON
 * body, and filtering it in the browser would filter one loaded page and call
 * it the pool - which is wrong the moment a second page exists. Deferred
 * whole rather than shipped shrunk: onlooker-4bw.
 */
const FILTERS: { value: "" | LessonStatus; label: string; empty?: string }[] = [
	// "All" carries no `empty`: an unfiltered pool with nothing in it is the
	// empty POOL, which says something else entirely.
	{ value: "", label: "All" },
	{ value: "active", label: "Active", empty: "No active lessons" },
	{ value: "retracted", label: "Retracted", empty: "No retracted lessons" },
	{ value: "refuted", label: "Refuted", empty: "No refuted lessons" },
	{ value: "superseded", label: "Superseded", empty: "No superseded lessons" },
];
```

Add the state and thread it through `load`:

```tsx
	const [filter, setFilter] = useState<"" | LessonStatus>("");
```

```tsx
	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const page = await listLessons(filter ? { statuses: [filter] } : {});
			setLessons(page.lessons);
		} catch (error) {
			setLessons(null);
			setLoadError(describeError(error, "Could not load the pool."));
		}
	}, [filter]);
```

`load` is already the effect's only dependency, so changing the filter refetches with no extra wiring.

Render the control at the top of the `.lessons-list` div, above the branch on `loadError`:

```tsx
			<div className="lessons-list">
				<div style={{ marginBottom: "1rem" }}>
					<label
						htmlFor="lesson-status"
						style={{
							display: "block",
							marginBottom: "0.35rem",
							fontFamily: "var(--font-display)",
							fontSize: "12px",
							letterSpacing: "1px",
							textTransform: "uppercase",
							color: PALETTE.muted,
						}}
					>
						Status
					</label>
					{/*
					  A native select rather than a new form primitive. One
					  filter does not justify a SelectField in form.tsx, and the
					  native control is what a screen reader and a keyboard
					  already know how to drive.
					*/}
					<select
						id="lesson-status"
						value={filter}
						onChange={(event) =>
							setFilter(event.target.value as "" | LessonStatus)
						}
						style={{
							padding: "0.4rem 0.5rem",
							background: "var(--ground)",
							color: "var(--ink)",
							border: `2px solid ${PALETTE.border}`,
							borderRadius: 0,
							fontFamily: "var(--font-body)",
						}}
					>
						{FILTERS.map((option) => (
							<option key={option.value || "all"} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>
```

Replace the single empty branch with the two states:

```tsx
				) : lessons.length === 0 ? (
					filter ? (
						// An empty FILTER result and an empty POOL say different
						// things. Telling someone whose pool is full to "connect a
						// machine" because they filtered to a status nothing holds
						// would be a lie, and the kind that makes a person doubt
						// everything else the page says.
						<EmptyState
							title={FILTERS.find((o) => o.value === filter)?.empty ?? "No lessons"}
						>
							Nothing in the pool holds that status right now.
						</EmptyState>
					) : (
						<EmptyState title="Nothing has synced yet">
							Lessons arrive when a machine pushes them.{" "}
							<NavLink to="/machines" style={{ color: PALETTE.accent }}>
								Connect a machine
							</NavLink>{" "}
							to start.
						</EmptyState>
					)
				) : (
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: PASS, 19 tests.

- [ ] **Step 5: Run the full gates**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green.

- [ ] **Step 6: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/src/pages/LessonsPage.tsx apps/web/src/__tests__/lessons-page.test.tsx
```

Subject: `feat(web): filter the pool by status, and say why it is empty :funnel:`
Body: why the filter goes to the server, and why an empty filter result gets its own sentence. Ends with `Refs: onlooker-yfw`.

---

### Task 6: Reach the second page

> **Scope note.** Section 5 of the spec says the layout route "fetches one page" and nothing about a Load more control. Tasks 1–5 satisfy the bead's acceptance criteria without this. It is here because a pool of 51 lessons that silently shows 50 is a page telling a quiet lie, and because the contract case for `/api/lessons` already describes `cursor` as "the field the pagination loop reads." If the reviewer wants this PR narrower, **drop this task** — nothing after it depends on it.

**Files:**
- Modify: `apps/web/src/pages/LessonsPage.tsx`, `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Consumes: `listLessons` with `{ cursor }`; `Button` from `../components/ui`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/__tests__/lessons-page.test.tsx`:

```tsx
describe("paging past the first page", () => {
	it("appends the next page without discarding the first", async () => {
		withPool([VITE], { cursor: "Y3Vyc29yLTE=", has_more: true });
		await at("/lessons");
		await screen.findByText(VITE.claim);

		mocks.listLessons.mockResolvedValue({
			lessons: [D1],
			cursor: null,
			has_more: false,
		});
		fireEvent.click(screen.getByRole("button", { name: /load more/i }));

		// The cursor the FIRST page returned, echoed back untouched. Sending
		// anything else - or nothing - restarts from the top and loops.
		await waitFor(() =>
			expect(mocks.listLessons).toHaveBeenLastCalledWith({
				cursor: "Y3Vyc29yLTE=",
			}),
		);
		expect(await screen.findByText(D1.claim)).toBeDefined();
		expect(screen.getByText(VITE.claim)).toBeDefined();
	});

	it("stops offering more once the server says there is none", async () => {
		withPool([VITE], { cursor: null, has_more: false });
		await at("/lessons");
		await screen.findByText(VITE.claim);
		expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
	});

	// Changing the filter is a different query, so its first page must start
	// from no cursor. Carrying the old one over would page through a boundary
	// the new filter never established.
	it("starts over when the filter changes", async () => {
		withPool([VITE], { cursor: "Y3Vyc29yLTE=", has_more: true });
		await at("/lessons");
		await screen.findByText(VITE.claim);

		withPool([]);
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "retracted" },
		});

		await waitFor(() =>
			expect(mocks.listLessons).toHaveBeenLastCalledWith({
				statuses: ["retracted"],
			}),
		);
	});
});
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: FAIL — no `Load more` button.

- [ ] **Step 3: Add paging to `LessonsPage.tsx`**

Import `Button`:

```tsx
import { Button, EmptyState, Panel, StatusBadge } from "../components/ui";
```

Add the cursor state:

```tsx
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [moreError, setMoreError] = useState<string | null>(null);
```

Record the cursor in `load`, which always starts a query from the top:

```tsx
	const load = useCallback(async () => {
		setLoadError(null);
		setMoreError(null);
		try {
			const page = await listLessons(filter ? { statuses: [filter] } : {});
			setLessons(page.lessons);
			// `has_more` and not `cursor !== null`, because those are two facts
			// and only one of them is the question being asked. The API returns
			// a cursor only when there is more, but reading has_more keeps this
			// honest if that ever stops being true.
			setCursor(page.has_more ? page.cursor : null);
		} catch (error) {
			setLessons(null);
			setCursor(null);
			setLoadError(describeError(error, "Could not load the pool."));
		}
	}, [filter]);
```

Add the append:

```tsx
	const loadMore = async () => {
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		setMoreError(null);
		try {
			// The filter travels with the cursor. A cursor is a position within
			// ONE query's ordering, so paging with a different filter than the
			// one that minted it walks a boundary that query never established.
			const page = await listLessons({
				...(filter ? { statuses: [filter] } : {}),
				cursor,
			});
			setLessons((current) => [...(current ?? []), ...page.lessons]);
			setCursor(page.has_more ? page.cursor : null);
		} catch (error) {
			// The pages already loaded stay. A failed append is a missing tail,
			// not a reason to throw away what the person is reading.
			setMoreError(describeError(error, "Could not load more lessons."));
		} finally {
			setLoadingMore(false);
		}
	};
```

Render it below the `<nav>`, inside the `Panel`:

```tsx
						{cursor ? (
							<div style={{ marginTop: "1rem" }}>
								<Button
									loading={loadingMore}
									loadingLabel="Loading..."
									onClick={() => void loadMore()}
								>
									Load more
								</Button>
							</div>
						) : null}

						{moreError ? (
							<p role="alert" style={{ color: PALETTE.danger }}>
								{moreError}
							</p>
						) : null}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx
```

Expected: PASS, 22 tests.

- [ ] **Step 5: Run the full gates**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green.

- [ ] **Step 6: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/src/pages/LessonsPage.tsx apps/web/src/__tests__/lessons-page.test.tsx
```

Subject: `feat(web): stop the pool ending at fifty without saying so :arrow_down:`
Body: why the cursor is echoed rather than reconstructed, and why a filter change starts over. Ends with `Refs: onlooker-yfw`.

---

### Task 7: Delete `DashboardPage` and land everything on `/lessons`

**Files:**
- Delete: `apps/web/src/pages/DashboardPage.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/SignupPage.tsx`, `apps/web/src/pages/HomePage.tsx`, `apps/web/src/pages/ProfilePage.tsx`, `apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/pages/VerifyEmailPage.tsx`, `apps/web/src/__tests__/login-page.test.tsx`

**Interfaces:**
- Consumes: the `/lessons` route from Task 2.
- Produces: nothing. This is the cutover half that removes the page; Task 8 removes the endpoint.

**Why now and not earlier.** Removing `/dashboard` before `/lessons` exists lands `RequireAuth` on a route that is not there — every authenticated redirect would reach the 404 element. That is why the spec puts the deletion in this PR rather than an earlier one, and why it is the second-to-last task rather than the first.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/__tests__/login-page.test.tsx`, change the route the test harness mounts and the assertions that name it. Replace the `/dashboard` route registration:

```tsx
				<Route path="/lessons" element={<p>lessons reached</p>} />
```

and the two cases that assert on it:

```tsx
	it("sends the user to the pool once login resolves", async () => {
		// ...unchanged setup...
		expect(await screen.findByText("lessons reached")).toBeDefined();
	});
```

```tsx
		expect(screen.queryByText("lessons reached")).toBeNull();
```

Update the comment above the second case, which currently reads "everyone to the dashboard regardless of where they were headed", to name the pool instead.

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/login-page.test.tsx
```

Expected: FAIL — `Unable to find an element with the text: lessons reached`. `LoginPage` still falls back to `/dashboard`.

- [ ] **Step 3: Repoint every landing and link**

`apps/web/src/pages/LoginPage.tsx` — the fallback and the comment above it:

```tsx
	// RequireAuth stashes the page the user was blocked from in `state.from`;
	// send them back there after login, falling back to the pool.
	const returnTo =
		(location.state as { from?: { pathname?: string } } | null)?.from
			?.pathname ?? "/lessons";
```

`apps/web/src/pages/SignupPage.tsx`:

```tsx
			await signup(email.trim(), password, name.trim());
			navigate("/lessons");
```

`apps/web/src/pages/HomePage.tsx`:

```tsx
					<Link to="/lessons">Go to the pool</Link>
```

`apps/web/src/pages/ProfilePage.tsx`:

```tsx
				<Link to="/lessons">Back to the pool</Link>
```

`apps/web/src/pages/SettingsPage.tsx`:

```tsx
				<FormLink to="/lessons">Back to the pool</FormLink>
```

`apps/web/src/pages/VerifyEmailPage.tsx`:

```tsx
					<FormLink to={user ? "/lessons" : "/login"}>
						{user ? "Go to the pool" : "Go to login"}
					</FormLink>
```

- [ ] **Step 4: Delete the page and its route**

```bash
git rm apps/web/src/pages/DashboardPage.tsx
```

In `apps/web/src/App.tsx`, delete the import line:

```tsx
import DashboardPage from "./pages/DashboardPage";
```

and the whole `/dashboard` route block:

```tsx
				<Route
					path="/dashboard"
					element={
						<auth.RequireAuth>
							<DashboardPage />
						</auth.RequireAuth>
					}
				/>
```

Leave the ErrorBoundary comment at line 32 alone — "That is where the blank dashboard went" is the incident this file's error reporting exists because of, not a reference to a route.

- [ ] **Step 5: Run the tests and make sure they pass**

```bash
pnpm --filter @onlooker/web exec vitest run
```

Expected: PASS. `apps/web/src/types/api.ts` still exports `DashboardData` and `mockApi.ts` still serves `/api/dashboard`; both come out in Task 8. Nothing imports `DashboardData` in a page any more, so `typecheck` is clean.

- [ ] **Step 6: Prove nothing routes to the deleted page**

```bash
grep -rn '"/dashboard"' --include='*.ts' --include='*.tsx' apps packages | grep -v node_modules
```

Expected: no output. If anything is left, it is a link this task missed.

- [ ] **Step 7: Run the full gates**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green.

- [ ] **Step 8: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add -A apps/web/src/pages apps/web/src/App.tsx apps/web/src/__tests__/login-page.test.tsx
```

Subject: `refactor(web): land the app on the pool, not a scaffold :door:`
Body: the dashboard served three numbers invented for a scaffold and the product has none of them; the pool is the page a person actually came for. Note that the deletion rides with `/lessons` so the landing route always exists. Ends with `Refs: onlooker-yfw`.

---

### Task 8: Retire `/api/dashboard` from the API, the contract, the mock and the types

**Files:**
- Modify: `apps/api/src/router.ts`, `apps/api/src/routes/data.ts`, `apps/api/src/routes/index.ts`, `apps/api/src/types/responses.ts`, `apps/api/src/index.ts`, `packages/api-contract/src/index.ts`, `apps/web/src/api/mockApi.ts`, `apps/web/src/api/types.ts`, `apps/web/src/types/api.ts`
- Test: `apps/web/src/api/mockResources.test.ts`, `apps/web/src/api/mock-base-url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Why all of it in one commit.** The contract table is run by *both* implementations. Deleting the handler without deleting the cases turns `apps/api/src/contract.test.ts` red; deleting the cases without deleting the handler leaves a route nothing describes. And `DashboardPage` is already gone, so the web types have no remaining consumer. A reviewer would not approve half of this, which is what makes it one task rather than three.

- [ ] **Step 1: Repoint the test that used the dashboard as a probe**

`apps/web/src/api/mock-base-url.test.ts` proves that `createMockFetch` routes `/api/*` and not only `/auth/*`. It happens to use `/api/dashboard` to do it, which is incidental — any authenticated `/api/` endpoint proves the same thing. Change it to `/api/users/me`, which survives:

```ts
		const response = await call(`${BASE}/api/users/me`, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(response.status).toBe(200);
```

- [ ] **Step 2: Run it to confirm it still passes**

```bash
pnpm --filter @onlooker/web exec vitest run src/api/mock-base-url.test.ts
```

Expected: PASS. This step is a rewrite of a test's incidental fixture, not a behavior change — running it before removing anything is what proves the probe still proves what it claimed to.

- [ ] **Step 3: Delete the contract cases**

In `packages/api-contract/src/index.ts`, delete from `anonymousCases`:

```ts
		{
			name: "dashboard, no token",
			path: "/api/dashboard",
			init: { method: "GET" },
			status: 401,
		},
```

and from `authenticatedCases`:

```ts
		{
			name: "dashboard, valid token",
			path: "/api/dashboard",
			init: { method: "GET" },
			status: 200,
			// Bare, with no { success, data } wrapper. This is the exact assertion
			// the blanked-dashboard incident needed and did not have.
			body: {
				user: expectObject,
				stats: expectObject,
				recentActivity: expectArray,
			},
			forbidden: NO_SECRETS,
		},
```

**Keep the file header comment.** Lines 16–23 narrate the blanked-dashboard incident and why `body` carries as much weight as `status`. That is the reason this package exists; the route being gone does not unmake the history. Add one line to it recording that the endpoint it names has since been removed:

```ts
 * Note the first was a SHAPE bug, not a status code: every response involved was
 * a 200 before and after. Status alone would not have caught it, which is why
 * `body` carries as much weight here as `status`.
 *
 * /api/dashboard itself was deleted in onlooker-yfw - it served three numbers
 * invented for a scaffold. The incident that named it is why this table exists,
 * so the account above is kept rather than edited out with the route.
 */
```

`expectArray` stays in use after this deletion — the three lesson-pool cases and the machines-list case all read it — so no import needs narrowing here.

- [ ] **Step 4: Delete the handler and its type**

`apps/api/src/routes/data.ts` — delete `handleGetDashboard` entirely (the doc comment and the function), narrow the import, and correct the file header, which promises dashboard schema work that will not happen:

```ts
/**
 * Protected data routes for WS4 (authenticated, protected resources).
 * These endpoints require a valid access token and return user-specific data.
 *
 * This file once also served /api/dashboard - three numbers invented for a
 * scaffold, deleted in onlooker-yfw along with the page that read them.
 */

import { jsonResponse, requireAuth } from "../middleware";
import type { UserProfile, WorkerEnv } from "../types";
```

`apps/api/src/routes/index.ts`:

```ts
export { handleGetUserProfile } from "./data";
```

`apps/api/src/router.ts` — remove `handleGetDashboard` from the import list at line 15, delete the route entry, and narrow the section heading:

```ts
	// =========================================================================
	// Protected data routes (WS4 - user profile)
	// =========================================================================
	{
		method: "GET",
		path: "/api/users/me",
		handler: handleGetUserProfile,
	},
```

`apps/api/src/types/responses.ts` — delete the `DashboardData` interface:

```ts
/**
 * Dashboard data response type.
 */
export interface DashboardData {
	user: UserProfile;
	stats?: {
		totalRequests?: number;
		lastActive?: string;
		totalSessions?: number;
		activeProjects?: number;
		unreadNotifications?: number;
	};
	recentActivity?: unknown[];
}
```

`apps/api/src/index.ts` — the WS4 line in the header:

```ts
 * - WS4: Protected user data (awaiting WS1 database)
```

- [ ] **Step 5: Delete the mock branch and the web types**

`apps/web/src/api/mockApi.ts` — narrow the import at line 3:

```ts
import type { UserProfile } from "../types/api";
```

correct the section comment above `mockDataApi`:

```ts
// ---------------------------------------------------------------------------
// WS4 protected data endpoints backing the authenticated Profile page.
// Additive over the auth + account mocks above and sharing their user + token
// state. /api/dashboard lived here too until onlooker-yfw deleted it.
// ---------------------------------------------------------------------------
```

and delete the whole `if (path === "/api/dashboard" && ...)` block.

`apps/web/src/api/mockResources.test.ts` — delete the `returns dashboard data with stats and recent activity` case and narrow the type import at line 2:

```ts
import type { UserProfile } from "../types/api";
```

`apps/web/src/types/api.ts` — delete `ActivityItem`, `DashboardStats` and `DashboardData`, leaving only:

```ts
export interface UserProfile {
	id: string;
	email: string;
	name: string;
	createdAt: string;
	lastLoginAt: string;
}
```

`apps/web/src/api/types.ts` — delete the `dashboard` row from the endpoint doc table at line 19, and drop `DashboardData` from the sentence at line 24 so it names `UserProfile` alone.

- [ ] **Step 6: Prove the endpoint is gone everywhere**

```bash
grep -rn "api/dashboard\|DashboardData\|DashboardStats\|ActivityItem\|handleGetDashboard" --include='*.ts' --include='*.tsx' apps packages | grep -v node_modules | grep -v '/dist/'
```

Expected: no output. Remaining prose mentions of the *incident* are fine and intended — check them by eye:

```bash
grep -rn -i "dashboard" --include='*.ts' --include='*.tsx' apps packages | grep -v node_modules | grep -v '/dist/'
```

Expected: only comments narrating the blank-dashboard incident (in `vite.config.ts`, `App.tsx`, `ErrorBoundary.tsx`, `lib/reportError.ts`, `middleware/error.ts`, `api-contract/src/index.ts`, the two test files that explain themselves by it) plus `db/timing.ts` and `observability.test.ts`, which mean the *Cloudflare* dashboard, and `website/src/data/plugins/librarian.ts`, which means dashboards in general. None of those are references to the route.

- [ ] **Step 7: Run the full gates**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green. In particular, `apps/api/src/contract.test.ts` and `apps/web/src/api/api-contract.test.ts` both run the same shortened table and both pass — which is the property that makes this a safe deletion rather than a hopeful one.

- [ ] **Step 8: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/api/src packages/api-contract/src/index.ts apps/web/src/api apps/web/src/types/api.ts
```

Subject: `refactor(api): retire the endpoint that served invented numbers :wastebasket:`
Body: `/api/dashboard` returned `totalSessions`, `activeProjects` and `unreadNotifications` — three figures the product does not have — and keeping it meant maintaining agreement between a mock and an API about data nobody reads. Note that deleting it removes a drift surface rather than adding one, and that the incident narrative in `api-contract` is deliberately kept. Ends with `Refs: onlooker-yfw`.

---

## Closing the bead

After Task 8, from the repo root:

```bash
pnpm test && pnpm typecheck && pnpm lint
git status
```

Then open the PR with the `/pr` skill. Do not push to `main`.

Once the PR merges:

```bash
bd close onlooker-yfw
bd ready
```

`onlooker-bmp` (the epic) and `onlooker-4bw` (stack filtering) both unblock at that point. `onlooker-k7w` is separately still marked in progress with an expired lease despite PR #87 having landed — worth closing in the same session.

---

## Self-review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| S1: `/lessons` and `/lessons/:id` are routes, session-authenticated | 2, 3 |
| S1: `/dashboard` deleted, `RequireAuth` lands on `/lessons` | 7 |
| S3: `GET /api/lessons` newest-first, cursor paginated, repeatable `?status` | 1, 5, 6 |
| S3: `GET /api/lessons/:id` exists so a deep link resolves | 1, 3 |
| S3: `PATCH /api/lessons/:id/status`, `active`/`retracted` only | 1, 4 |
| S3: list returns full bodies so the detail renders from memory | 3 |
| S3: stack filtering deferred to `onlooker-4bw` | 5 (recorded in a comment, not built) |
| S4: retract does not update optimistically | 4 |
| S4: 503 `sequence_contention` surfaced as retryable specifically | 4 |
| S5: `pages/LessonsPage.tsx`, `pages/LessonDetail.tsx`, `api/lessonsApi.ts` | 1, 2, 3 |
| S5: `/lessons` is a layout route; `/lessons/:id` renders from its list | 2, 3 |
| S6: empty pool links to Machines | 2 |
| S6: empty filter says "No retracted lessons" | 5 |
| S6: fetch failure uses `EmptyState`'s error-and-Retry | 2 |
| S7 (web): detail renders from memory on click, fetches on deep link | 3 |
| S7 (web): a failed retract leaves the row untouched | 4 |
| S7 (web): empty pool and empty filter render different states | 5 |
| Amendment: no `useBlocker`, `BrowserRouter` only | Constraints; nothing in this plan reaches for it |

Not covered, deliberately: `api-contract` cases for the three routes and the API-side tests from Section 7 already landed in `onlooker-yj5` — `packages/api-contract/src/index.ts` carries eight lesson cases today, and `apps/api/src/routes/lessons-browser.test.ts` and `db/lessons-browser.test.ts` both exist. Section 7's `promoted_at` / `expected-schema.ts` row landed in `onlooker-w5o`. This plan adds no contract cases; it only removes the two dashboard ones.

**Placeholder scan.** No TBDs, no "add error handling", no "similar to Task N". Every code step carries the code. Task 6 is explicitly marked as droppable rather than left ambiguous.

**Type consistency.** `LessonsContext` is defined in Task 2 with `{ lessons: Lesson[]; patchLesson: (id, status) => void }` and consumed under exactly those names in Tasks 3 and 4. `patchLesson` is never called `updateLesson`. `LessonPage.has_more` keeps the API's snake_case in every task that reads it (1, 6). `BrowserStatus` is defined in Task 1 and used in Task 4. `listLessons` takes one optional options object in every call site across Tasks 1, 2, 5 and 6.

**One risk worth naming before starting.** Task 4's `sequence_contention` check depends on `AuthApiError` surviving the `apiClient` path with its `code` intact. `createAuthApiClient` reads `envelope.error?.code` off the response body and puts it on the thrown error, and `apps/api`'s `errorHandler` emits `{ success: false, error: { code, message } }` — the contract pins that shape in the `an error carries the shared envelope` case. If Step 4 of that task fails on the `instanceof` check, construct a real `AuthApiError` in the test rather than weakening the production check to a message match.
