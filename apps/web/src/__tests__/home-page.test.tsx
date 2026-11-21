process.env.TZ = "UTC";

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/sessionsApi";
import HomePage from "../pages/HomePage";

const mocks = vi.hoisted(() => ({
	listSessions: vi.fn(),
	listLabels: vi.fn(),
}));

vi.mock("../api/sessionsApi", () => ({
	SESSION_ENDPOINTS: { sessions: "/api/sessions" },
	listSessions: mocks.listSessions,
}));

// importOriginal so labelIdentity stays real, as sessions-page.test.tsx does.
vi.mock("../api/labelsApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/labelsApi")>()),
	listLabels: mocks.listLabels,
}));

function session(over: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "s1",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 40,
		counts_by_prefix: {},
		counts_by_type: {},
		counts_by_project: {},
		plugins: [],
		prompts: 3,
		compactions: 0,
		...over,
	};
}

function renderPage() {
	return render(
		<MemoryRouter>
			<HomePage />
		</MemoryRouter>,
	);
}

describe("HomePage", () => {
	beforeEach(() => {
		// Date only, so promises and Testing Library's polling still run.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-18T15:00:00Z"));
		mocks.listSessions.mockReset();
		mocks.listLabels.mockReset();
		mocks.listLabels.mockResolvedValue(new Map());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("asks for one page of 200", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [],
			cursor: null,
			has_more: false,
		});
		renderPage();
		await screen.findByText(/no sessions in the last 7 days/i);
		expect(mocks.listSessions).toHaveBeenCalledWith({ limit: 200 });
	});

	it("shows loading until the sessions arrive", () => {
		mocks.listSessions.mockReturnValue(new Promise(() => {}));
		renderPage();
		expect(screen.getByRole("status").textContent).toMatch(
			/loading your sessions/i,
		);
	});

	it("counts only the sessions inside the window", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [
				session({ session_id: "in" }),
				session({
					session_id: "out",
					started_at: "2026-11-10T10:00:00Z",
					ended_at: "2026-11-10T11:00:00Z",
				}),
			],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect(
			(await screen.findByTestId("home-sessions-headline")).textContent,
		).toBe(
			"In the last 7 days your machines reported 1 session, 1h 0m in all.",
		);
	});

	it("says most recent when 200 rows don't reach back to the window's start", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [session()],
			cursor: "next",
			has_more: true,
		});
		renderPage();
		expect(
			(await screen.findByTestId("home-sessions-headline")).textContent,
		).toMatch(/^The most recent 1 session/);
	});

	// A failed read is not an empty week.
	it("says it could not load, and never shows the empty state, when the read fails", async () => {
		mocks.listSessions.mockRejectedValue(new Error("Server unreachable"));
		renderPage();
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/could not load your sessions/i);
		expect(alert.textContent).toMatch(/server unreachable/i);
		expect(screen.queryByText(/no sessions in the last 7 days/i)).toBeNull();
	});

	// Labels only rename keys. Without them every repository shows its key,
	// which is what the Sessions page does too.
	it("still renders the panel when the labels read fails", async () => {
		mocks.listLabels.mockRejectedValue(new Error("nope"));
		mocks.listSessions.mockResolvedValue({
			sessions: [
				session({
					counts_by_project: {
						aaaaaaaaaaaa: { basis: "remote", event_count: 30 },
					},
				}),
			],
			cursor: null,
			has_more: false,
		});
		renderPage();
		expect(await screen.findByTestId("home-sessions-headline")).toBeTruthy();
		// The raw key is the fallback, not a blank.
		expect(screen.getByText("aaaaaaaaaaaa")).toBeTruthy();
	});
});
