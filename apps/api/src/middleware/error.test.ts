import { describe, expect, it } from "vitest";
import { ApiError } from "../types";
import { errorHandler, jsonResponse } from "./error";

// Success and failure deliberately have different shapes, and the difference is
// load-bearing rather than an oversight.
//
// Every consumer reads a successful body as the payload itself: the /auth/*
// routes here return bare objects, apps/web's mock API mirrors that, and the
// shared client hands whatever it parsed straight to the caller without looking
// for a wrapper. jsonResponse used to wrap in { success, data } anyway, which
// only /api/* used - so DashboardPage read `.stats` off the envelope, got
// undefined, and threw during render. With no error boundary in apps/web that
// blanked the whole page, and the API looked healthy the entire time because it
// really was returning 200.
//
// Errors keep their envelope. A failure body has no natural payload shape, and
// the code/message pair is what the client reports.
describe("jsonResponse", () => {
	it("returns the payload itself, with no wrapper", async () => {
		const res = jsonResponse({ stats: { totalSessions: 3 } });

		expect(await res.json()).toEqual({ stats: { totalSessions: 3 } });
	});

	it("does not smuggle a success flag alongside the payload", async () => {
		const body = (await jsonResponse({ id: "u1" }).json()) as Record<
			string,
			unknown
		>;

		expect(Object.keys(body).sort()).toEqual(["id"]);
	});

	it("keeps the status it was given", () => {
		expect(jsonResponse({ ok: true }, 201).status).toBe(201);
	});
});

describe("errorHandler", () => {
	it("keeps the envelope, which is where the client looks for the reason", async () => {
		const res = errorHandler(new ApiError(409, "email_taken", "Already used"));

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			success: false,
			error: { code: "email_taken", message: "Already used" },
		});
	});
});
