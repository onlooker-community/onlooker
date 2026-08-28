import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	patch: vi.fn(),
}));

vi.mock("./client", () => ({
	apiClient: { get: mocks.get, patch: mocks.patch },
}));

const { getLesson, listLessons, setLessonStatus } = await import(
	"./lessonsApi"
);

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
		expect(mocks.get).toHaveBeenCalledWith("/api/lessons?cursor=YWJjKz0%3D");
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
