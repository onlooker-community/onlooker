import { afterEach } from "vitest";

/**
 * No CLI test may reach the network (ONL-295).
 *
 * Every client takes a `fetchImpl` that defaults to the global `fetch`, so a
 * test that forgets to pass one sends a real request. During ONL-197 one did:
 * a DELETE went to api.onlooker.dev, refused only because its token was fake.
 *
 * Refusing the request is not enough on its own. The client turns a thrown
 * fetch into "Could not reach ...", and a test that expects a failure passes on
 * that. So every URL is recorded, and the test that reached it fails after it.
 *
 * Assigned directly rather than with `vi.stubGlobal`, so a test's own
 * `vi.unstubAllGlobals()` restores this guard, not the real fetch.
 */
const reached: string[] = [];

/** The URLs that reached the guard since the last call, then forgets them. */
export function takeReached(): string[] {
	return reached.splice(0);
}

globalThis.fetch = ((input: string | URL | Request) => {
	const url = input instanceof Request ? input.url : String(input);
	reached.push(url);
	return Promise.reject(
		new Error(
			`A test reached the network: ${url}. Pass a fetchImpl, or stub fetch with vi.stubGlobal.`,
		),
	);
}) as typeof fetch;

afterEach(() => {
	const urls = takeReached();
	if (urls.length > 0) {
		throw new Error(
			`This test reached the network: ${urls.join(", ")}. Pass a fetchImpl, or stub fetch with vi.stubGlobal.`,
		);
	}
});
