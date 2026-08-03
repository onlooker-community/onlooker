// @vitest-environment jsdom
import { AuthApiError } from "@onlooker/auth-react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "../api/client";
import { useAuthenticatedFetch } from "./useAuthenticatedFetch";

// Mock the apiClient.request
vi.mock("../api/client", () => ({
	apiClient: {
		request: vi.fn(),
	},
}));

describe("useAuthenticatedFetch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("happy path: loading → data → no error", async () => {
		const mockData = { user: { id: "u1", email: "a@b.co" } };
		vi.mocked(clientModule.apiClient.request).mockResolvedValueOnce(mockData);

		const { result } = renderHook(() =>
			useAuthenticatedFetch<typeof mockData>("/auth/me"),
		);

		// Initially loading
		expect(result.current.loading).toBe(true);
		expect(result.current.data).toBeNull();
		expect(result.current.error).toBeNull();

		// After request completes
		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.data).toEqual(mockData);
		expect(result.current.error).toBeNull();
		expect(clientModule.apiClient.request).toHaveBeenCalledWith(
			"GET",
			"/auth/me",
			undefined,
		);
	});

	it("terminal 401: error is surfaced exactly once, no retry", async () => {
		vi.mocked(clientModule.apiClient.request).mockRejectedValueOnce(
			new AuthApiError(401, "unauthorized", "Session expired"),
		);

		const { result } = renderHook(() =>
			useAuthenticatedFetch<{ user: unknown }>("/auth/me"),
		);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.error).toBe("Session expired");
		expect(result.current.data).toBeNull();
		expect(result.current.loading).toBe(false);
		// request called exactly once (no hook-level retry)
		expect(clientModule.apiClient.request).toHaveBeenCalledTimes(1);
	});

	it("non-401 error: surfaced once, no auth refresh called", async () => {
		vi.mocked(clientModule.apiClient.request).mockRejectedValueOnce(
			new Error("Internal server error"),
		);

		const { result } = renderHook(() =>
			useAuthenticatedFetch<{ data: unknown }>("/data"),
		);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.error).toBe("Internal server error");
		expect(result.current.data).toBeNull();
		expect(clientModule.apiClient.request).toHaveBeenCalledTimes(1);
	});

	it("refetch: re-issues request and clears prior error", async () => {
		vi.mocked(clientModule.apiClient.request)
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValueOnce({ data: "success" });

		const { result } = renderHook(() =>
			useAuthenticatedFetch<{ data: string }>("/data"),
		);

		await waitFor(() => {
			expect(result.current.error).toBe("Network error");
		});

		expect(result.current.data).toBeNull();
		expect(result.current.error).toBe("Network error");

		// Refetch. Wrapped in act() so the reloadToken state update flushes
		// synchronously — otherwise loading is still false from the failed
		// first request and waitFor resolves before the refetch re-runs.
		act(() => {
			result.current.refetch();
		});

		await waitFor(() => {
			expect(result.current.data).toEqual({ data: "success" });
		});

		expect(result.current.data).toEqual({ data: "success" });
		expect(result.current.error).toBeNull();
		expect(clientModule.apiClient.request).toHaveBeenCalledTimes(2);
	});
});
