import { describe, it, expect, beforeEach } from "vitest";
import { createLocalStorageTokenStorage } from "./index";

describe("createLocalStorageTokenStorage", () => {
	let mockStorage: Record<string, string>;

	beforeEach(() => {
		mockStorage = {};
	});

	const createMockStorage = (): Storage => {
		return {
			getItem: (key: string) => mockStorage[key] || null,
			setItem: (key: string, value: string) => {
				mockStorage[key] = value;
			},
			removeItem: (key: string) => {
				delete mockStorage[key];
			},
			clear: () => {
				mockStorage = {};
			},
			key: () => null,
			length: Object.keys(mockStorage).length,
		} as Storage;
	};

	it("stores and retrieves token", () => {
		const storage = createLocalStorageTokenStorage("auth_token", createMockStorage());
		storage.setToken("test-token-123");
		expect(storage.getToken()).toBe("test-token-123");
	});

	it("clears token", () => {
		const storage = createLocalStorageTokenStorage("auth_token", createMockStorage());
		storage.setToken("test-token-123");
		storage.clearToken();
		expect(storage.getToken()).toBeNull();
	});

	it("returns null if no token is set", () => {
		const storage = createLocalStorageTokenStorage("auth_token", createMockStorage());
		expect(storage.getToken()).toBeNull();
	});

	it("uses custom key", () => {
		const mockStorageInstance = createMockStorage();
		const storage = createLocalStorageTokenStorage("custom_key", mockStorageInstance);
		storage.setToken("token-123");
		expect(mockStorageInstance.getItem("custom_key")).toBe("token-123");
	});

	it("handles storage errors gracefully", () => {
		const errorStorage: Storage = {
			getItem: () => {
				throw new Error("Storage error");
			},
			setItem: () => {
				throw new Error("Storage error");
			},
			removeItem: () => {
				throw new Error("Storage error");
			},
			clear: () => {
				throw new Error("Storage error");
			},
			key: () => null,
			length: 0,
		} as Storage;

		const storage = createLocalStorageTokenStorage("auth_token", errorStorage);

		// Should not throw
		expect(storage.getToken()).toBeNull();
		storage.setToken("test-token");
		storage.clearToken();
	});
});
