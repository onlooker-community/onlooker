# CLI Lesson Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the lesson pool a producer — an `apps/cli` that links a machine with a pasted token and pushes approved lessons to `POST /lessons`.

**Architecture:** A TypeScript CLI in the monorepo with three commands and no background process. It imports `ZLesson` from `packages/lesson-contract`, so it validates exactly what the API validates. The sync is stateless because the server dedupes by lesson id. It bundles to a single JS file with esbuild and ships through Homebrew with `depends_on "node"`.

**Tech Stack:** Node ≥20.19 (global `fetch`, `readline/promises`), TypeScript with `moduleResolution: "bundler"`, zod via `@onlooker-community/lesson-contract`, esbuild 0.28.1 for bundling, Vitest, pnpm + turbo.

## Global Constraints

- **American English** in every comment, identifier and user-facing string: `color`, `behavior`, `normalize`, `canceled`, `analyze`.
- Commits go through the `/commit` skill. Format: `<type>(<scope>): <subject> :emoji:`, **subject ≤72 characters including the emoji**, why-focused body wrapped at 80, mood emoji reflecting *this* change rather than the type label, body ending `Refs: onlooker-v72`.
- **Branch and PR, never a direct push to `main`.** Work happens on `feat/cli-lesson-sync`, which already carries the spec.
- Never `git add -A` or `git add .` — stage intentionally.
- **A machine token authenticates exactly three routes:** `POST /lessons`, `GET /lessons`, `POST /lessons/:id/status`. It does **not** authenticate `/api/lessons`, which is the browser's session route.
- **`MAX_BATCH` is 100.** No request may carry more lessons than that.
- **The sync is stateless.** No buffer, no cursor, no watermark, no record of what was sent. The server returns `created` or `taken` per lesson.
- **A 4xx that cannot succeed on a retry must be distinguishable from one that can** — in the exit code and in the message. This is the entire lesson of `onlooker-33i`.
- **The token is a credential.** Prompted, never an argument; written `0600`; never logged, never echoed.
- Gates from the repo root: `pnpm test`, `pnpm typecheck`, `pnpm lint`. All three green before every commit.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/cli/package.json` | Workspace package, `onlooker` bin, esbuild bundle script. |
| `apps/cli/tsconfig.json` | Extends the shared Node config. |
| `apps/cli/src/config.ts` | Where the token lives, how it is read and written. |
| `apps/cli/src/api.ts` | The HTTP client and — the important half — failure classification. |
| `apps/cli/src/lessons.ts` | Finding, parsing and validating lessons on disk; batching. |
| `apps/cli/src/commands/link.ts` | Prompt, verify, persist. |
| `apps/cli/src/commands/sync.ts` | Discover, validate, push, report. |
| `apps/cli/src/commands/status.ts` | What is linked, what is pending. |
| `apps/cli/src/main.ts` | Argument dispatch and the single place that turns a failure into an exit code. |
| `apps/cli/src/__tests__/*.test.ts` | One file per module above. |
| `apps/cli/src/__tests__/fixtures/lesson.json` | One contract-valid lesson. The only thing that can exercise the whole path. |
| `.github/workflows/release-cli.yml` | Tag → bundle → GitHub release. |
| `scripts/write-formula.mjs` | Generates the Homebrew formula from a release artifact. |

**Modified:**

| File | Change |
|---|---|
| `.github/workflows/deploy.yml` | Add a `changes` job and gate `deploy-staging` on it, so a CLI-only commit runs CI but does not deploy. Triggers stay unfiltered. |
| `homebrew-tap/Formula/onlooker.rb` | Regenerated: node dependency, no service block, caveat. *(Separate repository — Task 7.)* |

**Not touched:** `apps/api`, `apps/web`, `packages/lesson-contract`. The CLI consumes the contract; it does not change it.

---

## Notes for whoever builds this

**This CLI will sync zero lessons when you finish it, and that is expected.** Nothing writes to `lessons/approved/` yet — the ecosystem marks that step as an unbuilt issue. Sixteen project directories on a real machine, one `lessons/` subtree, two proposals, zero approved. The fixture in Task 4 is the only way to exercise the whole path, which is why it is a required test rather than a convenience.

**`packages/lesson-contract` needs building before this typechecks.** It publishes types from `dist/`, and turbo's `typecheck` depends on `^typecheck` rather than `^build`. If `tsc --noEmit` cannot resolve `@onlooker-community/lesson-contract`, run `pnpm build` once. `apps/api` already lives with this.

**Do not add a CLI framework.** Three commands do not justify commander or yargs. `process.argv` and a switch is the whole dispatcher, and it is easier to read than the framework would be.

---

### Task 1: The package, and where the token lives

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/src/config.ts`, `apps/cli/src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `interface CliConfig { apiBaseUrl: string; machineToken?: string }`, `configPath(env?: NodeJS.ProcessEnv): string`, `readConfig(env?): CliConfig`, `writeConfig(config: CliConfig, env?): void`, `onlookerDir(env?): string`. Every later task consumes these.

- [ ] **Step 1: Create the package**

`apps/cli/package.json`:

```json
{
	"name": "@onlooker/cli",
	"version": "2.0.0",
	"private": true,
	"type": "module",
	"bin": { "onlooker": "./dist/onlooker.mjs" },
	"scripts": {
		"build": "esbuild src/main.ts --bundle --platform=node --target=node20 --format=esm --outfile=dist/onlooker.mjs --banner:js='#!/usr/bin/env node'",
		"lint": "biome check src",
		"lint:fix": "biome check --write src",
		"typecheck": "tsc --noEmit",
		"test": "vitest run",
		"clean": "rimraf dist node_modules .turbo"
	},
	"dependencies": {
		"@onlooker-community/lesson-contract": "workspace:*"
	},
	"devDependencies": {
		"@onlooker/config-biome": "workspace:*",
		"@onlooker/config-typescript": "workspace:*",
		"esbuild": "0.28.1",
		"typescript": "^5.6.3",
		"vitest": "^4.1.9"
	}
}
```

`version` is `2.0.0` and not `0.0.0`: it has to clear the retired Go CLI's `v1.11.2` or `brew upgrade` will refuse the new formula.

`apps/cli/tsconfig.json`:

```json
{
	"extends": "@onlooker/config-typescript/base.json",
	"compilerOptions": {
		"module": "ESNext",
		"moduleResolution": "bundler",
		"lib": ["ES2023"],
		"types": ["node"]
	},
	"include": ["src"],
	"exclude": ["dist", "node_modules"]
}
```

Then, from the repo root: `pnpm install`. `pnpm-workspace.yaml` already globs `apps/*`, so nothing else needs registering.

- [ ] **Step 2: Write the failing test**

`apps/cli/src/__tests__/config.test.ts`:

```ts
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, onlookerDir, readConfig, writeConfig } from "../config";

function sandbox(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
}

describe("config", () => {
	it("defaults the API to production and carries no token", () => {
		const config = readConfig(sandbox());
		expect(config.apiBaseUrl).toBe("https://api.onlooker.dev");
		expect(config.machineToken).toBeUndefined();
	});

	it("round-trips a token", () => {
		const env = sandbox();
		writeConfig({ apiBaseUrl: "https://api.onlooker.dev", machineToken: "t" }, env);
		expect(readConfig(env).machineToken).toBe("t");
	});

	// The file holds a credential that is shown once and recoverable only by
	// revoking the machine. World-readable is not acceptable for that.
	it("writes the config readable only by its owner", () => {
		const env = sandbox();
		writeConfig({ apiBaseUrl: "https://api.onlooker.dev", machineToken: "t" }, env);
		expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
	});

	// An override is what lets anyone point at staging without editing a file,
	// and what lets these tests avoid the real home directory.
	it("honors ONLOOKER_API_URL over the stored value", () => {
		const env = sandbox();
		writeConfig({ apiBaseUrl: "https://api.onlooker.dev" }, env);
		env.ONLOOKER_API_URL = "https://api-staging.onlooker.dev";
		expect(readConfig(env).apiBaseUrl).toBe("https://api-staging.onlooker.dev");
	});

	it("puts the config beside the lessons it syncs", () => {
		const env = sandbox();
		expect(configPath(env)).toBe(join(onlookerDir(env), "cli.json"));
	});

	// A corrupt file should say so rather than silently resetting the token and
	// making the next command ask for it again with no explanation.
	it("refuses to guess at a corrupt config", () => {
		const env = sandbox();
		writeConfig({ apiBaseUrl: "https://api.onlooker.dev" }, env);
		require("node:fs").writeFileSync(configPath(env), "{ not json");
		expect(() => readConfig(env)).toThrow(/could not be read/i);
	});
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/config.test.ts`
Expected: FAIL — `Failed to resolve import "../config"`.

- [ ] **Step 4: Write the implementation**

`apps/cli/src/config.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the CLI keeps the machine token, and which API it talks to.
 *
 * Deliberately one flat JSON file rather than a config library. There are two
 * settings; a library would be more code than the thing it configures.
 */
export interface CliConfig {
	apiBaseUrl: string;
	machineToken?: string;
}

const DEFAULT_API = "https://api.onlooker.dev";

/**
 * `$ONLOOKER_DIR`, or `~/.onlooker`. The ecosystem's plugins write here, so the
 * CLI reads its config from the same root it reads lessons from - one directory
 * to back up, one to delete.
 *
 * The `env` parameter is not decoration: it is what lets the tests run against a
 * temp directory instead of the developer's real home.
 */
export function onlookerDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.ONLOOKER_DIR ?? join(homedir(), ".onlooker");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(onlookerDir(env), "cli.json");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
	const path = configPath(env);
	let stored: Partial<CliConfig> = {};

	try {
		stored = JSON.parse(readFileSync(path, "utf8")) as Partial<CliConfig>;
	} catch (error) {
		// A missing file is the first-run case and means "no token yet". Anything
		// else - malformed JSON, a permissions problem - is a real fault, and
		// treating it as absent would silently discard a token the user pasted
		// and send them back to `onlooker link` with no idea why.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`${path} could not be read: ${(error as Error).message}`);
		}
	}

	return {
		apiBaseUrl: env.ONLOOKER_API_URL ?? stored.apiBaseUrl ?? DEFAULT_API,
		machineToken: stored.machineToken,
	};
}

export function writeConfig(
	config: CliConfig,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const path = configPath(env);
	mkdirSync(dirname(path), { recursive: true });
	// 0600 from the moment it exists. Writing world-readable and chmod-ing after
	// leaves a window where the token is readable by anyone on the machine.
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/config.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full gates, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add apps/cli/package.json apps/cli/tsconfig.json apps/cli/src/config.ts apps/cli/src/__tests__/config.test.ts pnpm-lock.yaml
```

Subject: `feat(cli): give the CLI a home and a place for its token :key:`
Body: why the config sits under `$ONLOOKER_DIR`, why the mode is set at write time rather than after, and why a corrupt file throws rather than resetting.

---

### Task 2: The API client, and telling failures apart

**Files:**
- Create: `apps/cli/src/api.ts`, `apps/cli/src/__tests__/api.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `type Failure`, `class ApiError extends Error { readonly failure: Failure }`, `classify(status: number, url: string, body: unknown): Failure`, `createClient(baseUrl: string, token: string): ApiClient`, `interface ApiClient { verify(): Promise<void>; push(lessons: unknown[]): Promise<PushResponse> }`, `type Outcome = "created" | "noop" | "conflict" | "invalid" | "error"`, `interface PushResult { id: string; outcome: Outcome; seq?: number; error?: string }`, `interface PushResponse { results: PushResult[] }`. Tasks 3, 4 and 5 consume all of these.

**This task is the point of the whole plan.** The retired CLI mapped every status ≥ 400 to one generic error and retried forever, which is why a 404 read as a flaky network for two months while the local buffer grew. Classification is not a nicety here; it is the defect being fixed.

- [ ] **Step 1: Write the failing test**

`apps/cli/src/__tests__/api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { classify, createClient } from "../api";

const URL_ = "https://api.onlooker.dev/lessons";

describe("classify", () => {
	// Each of these is a different instruction to the user. Collapsing them into
	// one message is exactly the defect this replaces.
	it("calls 401 a credential problem and names the fix", () => {
		const f = classify(401, URL_, {});
		expect(f.kind).toBe("unauthorized");
		expect(f.message).toMatch(/onlooker link/);
	});

	// The failure that hid for two months. It must name the URL, because the
	// whole reason nobody noticed was that the message never said what 404'd.
	it("calls 404 terminal and names the URL", () => {
		const f = classify(404, URL_, {});
		expect(f.kind).toBe("gone");
		expect(f.message).toContain(URL_);
	});

	it("surfaces the API's own message on a 400", () => {
		const f = classify(400, URL_, {
			error: { code: "batch_too_large", message: "At most 100 lessons per request" },
		});
		expect(f.kind).toBe("rejected");
		expect(f.message).toContain("At most 100 lessons per request");
	});

	it("calls 5xx transient and says a retry is worth it", () => {
		const f = classify(503, URL_, {});
		expect(f.kind).toBe("transient");
		expect(f.message).toMatch(/again/i);
	});

	// 429 is the one 4xx that IS worth retrying. Bucketing it with the others
	// would tell the user to give up on a request that would succeed.
	it("calls 429 transient rather than terminal", () => {
		expect(classify(429, URL_, {}).kind).toBe("transient");
	});
});

describe("createClient", () => {
	function withFetch(status: number, body: unknown) {
		return vi.fn().mockResolvedValue({
			ok: status < 400,
			status,
			json: async () => body,
		});
	}

	it("sends the token as a bearer on verify", async () => {
		const fetchImpl = withFetch(200, { lessons: [], has_more: false });
		await createClient("https://api.onlooker.dev", "tok", fetchImpl).verify();
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://api.onlooker.dev/lessons?since=0&limit=1");
		expect(init.headers.Authorization).toBe("Bearer tok");
	});

	// GET /lessons is machine-authenticated; /api/lessons is the browser's
	// session route and would reject every valid machine token. Pinning the URL
	// is what stops that mix-up returning.
	it("verifies against the machine route, never the browser one", async () => {
		const fetchImpl = withFetch(200, { lessons: [], has_more: false });
		await createClient("https://api.onlooker.dev", "tok", fetchImpl).verify();
		expect(fetchImpl.mock.calls[0][0]).not.toContain("/api/lessons");
	});

	it("throws a classified error rather than a bare status", async () => {
		const client = createClient("https://api.onlooker.dev", "tok", withFetch(401, {}));
		await expect(client.verify()).rejects.toMatchObject({
			failure: { kind: "unauthorized" },
		});
	});

	// A refused connection never reaches a status code, and it is the case the
	// user can actually do something about by trying again.
	it("treats a network failure as transient", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		const client = createClient("https://api.onlooker.dev", "tok", fetchImpl);
		await expect(client.push([])).rejects.toMatchObject({
			failure: { kind: "transient" },
		});
	});

	it("posts lessons as a bare array under `lessons`", async () => {
		const fetchImpl = withFetch(200, { results: [] });
		await createClient("https://api.onlooker.dev", "tok", fetchImpl).push([{ id: "x" }]);
		const [, init] = fetchImpl.mock.calls[0];
		expect(JSON.parse(init.body)).toEqual({ lessons: [{ id: "x" }] });
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/api.test.ts`
Expected: FAIL — `Failed to resolve import "../api"`.

- [ ] **Step 3: Write the implementation**

`apps/cli/src/api.ts`:

```ts
/**
 * The hosted API, and the four things going wrong can mean.
 *
 * The CLI this replaces mapped every status >= 400 to one error string and let
 * its caller retry on all of them. A 404 was therefore indistinguishable from a
 * flaky network: when the ingest endpoint moved, the daemon retried the same
 * batch every thirty seconds for two months while its local buffer grew without
 * bound, and the only signal was a warning nobody read. Four kinds, four
 * messages, one of them retryable.
 */
export type Failure =
	| { kind: "unauthorized"; message: string }
	| { kind: "gone"; message: string }
	| { kind: "rejected"; message: string }
	| { kind: "transient"; message: string };

export class ApiError extends Error {
	constructor(readonly failure: Failure) {
		super(failure.message);
		this.name = "ApiError";
	}
}

/** The shape apps/api's errorHandler wraps every failure in. */
interface ErrorEnvelope {
	error?: { code?: string; message?: string };
}

export function classify(status: number, url: string, body: unknown): Failure {
	const detail = (body as ErrorEnvelope)?.error?.message;

	if (status === 401) {
		return {
			kind: "unauthorized",
			message:
				"That machine token was rejected. Mint a new one on the Machines page " +
				"and run `onlooker link` again.",
		};
	}
	// 429 sits with the 5xx family rather than its 4xx neighbors: it is the one
	// client error that succeeds on a retry, and telling someone to give up on it
	// would be wrong.
	if (status === 429 || status >= 500) {
		return {
			kind: "transient",
			message: `The API answered ${status}. Nothing was lost - run the command again.`,
		};
	}
	if (status === 404) {
		return {
			kind: "gone",
			message:
				`${url} returned 404. The endpoint this CLI expects is not there, ` +
				"which is a version mismatch rather than something a retry fixes.",
		};
	}
	return {
		kind: "rejected",
		message: detail
			? `The API rejected the request: ${detail}`
			: `The API rejected the request with ${status}.`,
	};
}

/**
 * The five answers `POST /lessons` gives per lesson, named exactly as the API
 * names them.
 *
 * Not a boolean and not a loose string. The route's own source warns that
 * `invalid` means "this lesson will never be accepted, stop sending it" while
 * `error` means retry - so a client that collapses them either drops a lesson
 * permanently or retries one forever.
 */
export type Outcome = "created" | "noop" | "conflict" | "invalid" | "error";

export interface PushResult {
	id: string;
	outcome: Outcome;
	seq?: number;
	error?: string;
}

export interface PushResponse {
	results: PushResult[];
}

export interface ApiClient {
	/** Cheapest call a machine token can make, and it has no side effects. */
	verify(): Promise<void>;
	push(lessons: unknown[]): Promise<PushResponse>;
}

export function createClient(
	baseUrl: string,
	token: string,
	fetchImpl: typeof fetch = fetch,
): ApiClient {
	async function call<T>(path: string, init?: RequestInit): Promise<T> {
		const url = `${baseUrl}${path}`;
		let response: Response;
		try {
			response = await fetchImpl(url, {
				...init,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...init?.headers,
				},
			});
		} catch (error) {
			// No status to classify - the request never arrived. That is always
			// worth trying again, and saying so is the difference between "your
			// wifi dropped" and "give up".
			throw new ApiError({
				kind: "transient",
				message: `Could not reach ${baseUrl}: ${(error as Error).message}`,
			});
		}

		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw new ApiError(classify(response.status, url, body));
		return body as T;
	}

	return {
		verify: async () => {
			// GET /lessons, not /api/lessons. A machine token authenticates the
			// machine-side delta read; /api/lessons is the browser's
			// session-authenticated route and would reject every valid token.
			await call("/lessons?since=0&limit=1");
		},
		push: (lessons) =>
			call<PushResponse>("/lessons", {
				method: "POST",
				body: JSON.stringify({ lessons }),
			}),
	};
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/api.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Revert-check the classification**

Replace the whole body of `classify` with a single `return { kind: "transient", message: \`API returned ${status}\` }` — the retired CLI's behavior. Confirm the 401, 404 and 400 tests fail. Restore. **Report which assertions failed**: a classifier that cannot fail is the bug this task exists to prevent, wearing a passing suite.

- [ ] **Step 6: Run the full gates, then commit**

Subject: `feat(cli): tell a dead endpoint from a bad network :satellite:`
Body: the two-month silent failure this prevents, why 429 sits with the 5xx family, and why the 404 message names the URL.

---

### Task 3: `onlooker link`

**Files:**
- Create: `apps/cli/src/commands/link.ts`, `apps/cli/src/__tests__/link.test.ts`

**Interfaces:**
- Consumes: `readConfig`, `writeConfig`, `CliConfig` from `../config`; `createClient`, `ApiError` from `../api`.
- Produces: `link(deps: LinkDeps): Promise<string>` where `interface LinkDeps { env?: NodeJS.ProcessEnv; prompt: () => Promise<string>; fetchImpl?: typeof fetch }`, returning the message to print. Task 6's dispatcher calls it.

- [ ] **Step 1: Write the failing test**

`apps/cli/src/__tests__/link.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../config";
import { link } from "../commands/link";

const env = () => ({ ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-link-")) });
const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ lessons: [] }) });

describe("link", () => {
	it("stores a token the API accepts", async () => {
		const e = env();
		await link({ env: e, prompt: async () => "good-token", fetchImpl: ok() });
		expect(readConfig(e).machineToken).toBe("good-token");
	});

	// Storing first and verifying later would leave a bad token on disk and make
	// every later command fail with a puzzle instead of a rejection here.
	it("does not store a token the API rejects", async () => {
		const e = env();
		const rejects = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
		await expect(
			link({ env: e, prompt: async () => "bad-token", fetchImpl: rejects }),
		).rejects.toMatchObject({ failure: { kind: "unauthorized" } });
		expect(readConfig(e).machineToken).toBeUndefined();
	});

	it("trims what was pasted", async () => {
		const e = env();
		await link({ env: e, prompt: async () => "  padded\n", fetchImpl: ok() });
		expect(readConfig(e).machineToken).toBe("padded");
	});

	it("refuses an empty token without calling the API", async () => {
		const fetchImpl = ok();
		await expect(
			link({ env: env(), prompt: async () => "   ", fetchImpl }),
		).rejects.toThrow(/no token/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// The token is shown once and recoverable only by revoking the machine.
	// Echoing it into a success message would put it in the scrollback.
	it("never repeats the token back", async () => {
		const message = await link({
			env: env(),
			prompt: async () => "sensitive-value",
			fetchImpl: ok(),
		});
		expect(message).not.toContain("sensitive-value");
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/link.test.ts`
Expected: FAIL — `Failed to resolve import "../commands/link"`.

- [ ] **Step 3: Write the implementation**

`apps/cli/src/commands/link.ts`:

```ts
import { createClient } from "../api";
import { readConfig, writeConfig } from "../config";

export interface LinkDeps {
	env?: NodeJS.ProcessEnv;
	/** Injected so tests never touch a TTY. `main.ts` supplies the real one. */
	prompt: () => Promise<string>;
	fetchImpl?: typeof fetch;
}

/**
 * Connect this machine to an account with a token minted on the Machines page.
 *
 * A paste rather than the device-authorization dance the retired CLI ran. The
 * server side of that dance no longer exists, and the browser already mints and
 * reveals exactly this credential - the reveal was built for it, and says as
 * much.
 */
export async function link({
	env = process.env,
	prompt,
	fetchImpl,
}: LinkDeps): Promise<string> {
	const token = (await prompt()).trim();
	if (!token) throw new Error("No token entered. Nothing was changed.");

	const config = readConfig(env);
	// Verified before it is written, never after. A token stored without checking
	// turns one clear rejection here into a puzzle at the next command.
	await createClient(config.apiBaseUrl, token, fetchImpl).verify();

	writeConfig({ ...config, machineToken: token }, env);
	// Deliberately does not echo the token: it is shown once, and repeating it
	// into the scrollback undoes the care the one-time reveal takes.
	return `Linked to ${config.apiBaseUrl}. Run \`onlooker sync\` to push lessons.`;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/link.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full gates, then commit**

Subject: `feat(cli): link a machine with a token from the browser :link:`
Body: why paste rather than a device flow, and why the token is verified before it is stored.

---

### Task 4: Finding and validating lessons

**Files:**
- Create: `apps/cli/src/lessons.ts`, `apps/cli/src/__tests__/lessons.test.ts`, `apps/cli/src/__tests__/fixtures/lesson.json`

**Interfaces:**
- Consumes: `onlookerDir` from `../config`; `ZLesson`, `type TLesson` from `@onlooker-community/lesson-contract`.
- Produces: `type Discovery = { kind: "no-onlooker-dir"; path: string } | { kind: "no-librarian-dir"; path: string } | { kind: "found"; files: string[] }`, `discoverApproved(env?): Discovery`, `type Parsed = { ok: true; lesson: TLesson } | { ok: false; file: string; error: string }`, `parseLesson(file: string): Parsed`, `batch<T>(items: T[], size: number): T[][]`, `MAX_BATCH = 100`. Tasks 5 and 6 consume these.

- [ ] **Step 1: Create the fixture**

`apps/cli/src/__tests__/fixtures/lesson.json` — one contract-valid lesson. It is the only artifact that can exercise link → sync → pool end to end, because nothing writes to `approved/` yet.

Identifiers must satisfy the contract's regexes: ULIDs are 26 Crockford base32 characters (`I`, `L`, `O`, `U` excluded), `project_key` is 12 hex, `author_key` is 32 hex.

```json
{
	"id": "01KZ45MKAM734ZS7JK24D2DK0R",
	"schema_version": 2,
	"claim": "Vite 5 drops a top-level await in a worker entry",
	"rationale": "esbuild lowers it to a promise the worker runtime never awaits.",
	"evidence": {
		"artifact_ids": ["01KZ45MKAM734ZS7JK24D2DK1A"],
		"session_ids": ["sess-1"],
		"project_key": "4c1de90ab372",
		"observed_at": "2026-08-20T10:00:00.000Z",
		"resolution": "Moved the await inside the fetch handler."
	},
	"applies_to": {
		"stack": ["vite"],
		"scope": { "kind": "versioned", "versions": { "vite": "<6" } },
		"file_patterns": ["src/worker.ts"],
		"task_kinds": ["build"]
	},
	"visibility": "private",
	"consensus": { "judges": 3, "agreed": 3, "decided_at": "2026-08-21T10:00:00.000Z" },
	"status": "active",
	"superseded_by": null,
	"source": "local",
	"author_key": "9f2c41ba7d5e08c3b6a1f470d2e95c8b",
	"promoted_at": "2026-08-22T10:00:00.000Z"
}
```

- [ ] **Step 2: Write the failing test**

`apps/cli/src/__tests__/lessons.test.ts`:

```ts
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batch, discoverApproved, MAX_BATCH, parseLesson } from "../lessons";

const FIXTURE = join(__dirname, "fixtures", "lesson.json");

function root(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-lessons-")) };
}

function approvedDir(env: NodeJS.ProcessEnv, key = "4c1de90ab372"): string {
	const dir = join(env.ONLOOKER_DIR as string, "librarian", key, "lessons", "approved");
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("discoverApproved", () => {
	// Three states a recursive glob would collapse into one silent zero. Until
	// the ecosystem's promotion step ships, the third is the expected one, so
	// telling it from the first two is the difference between "nothing to sync
	// yet" and "your install is wrong".
	it("distinguishes a missing ONLOOKER_DIR", () => {
		const env = { ONLOOKER_DIR: join(tmpdir(), "definitely-not-here-onlooker") };
		expect(discoverApproved(env).kind).toBe("no-onlooker-dir");
	});

	it("distinguishes an ONLOOKER_DIR with no librarian directory", () => {
		expect(discoverApproved(root()).kind).toBe("no-librarian-dir");
	});

	it("reports an empty approved directory as found-but-empty", () => {
		const env = root();
		approvedDir(env);
		const found = discoverApproved(env);
		expect(found).toEqual({ kind: "found", files: [] });
	});

	it("finds lessons across every project", () => {
		const env = root();
		cpSync(FIXTURE, join(approvedDir(env, "4c1de90ab372"), "a.json"));
		cpSync(FIXTURE, join(approvedDir(env, "aaaaaaaaaaaa"), "b.json"));
		const found = discoverApproved(env);
		expect(found.kind).toBe("found");
		expect(found.kind === "found" && found.files).toHaveLength(2);
	});

	// proposals/ holds candidates that have not been judged. Pushing one would
	// put an unjudged claim into a pool whose whole premise is consensus.
	it("never reads proposals", () => {
		const env = root();
		const proposals = join(env.ONLOOKER_DIR as string, "librarian", "k", "lessons", "proposals");
		mkdirSync(proposals, { recursive: true });
		cpSync(FIXTURE, join(proposals, "p.json"));
		expect(discoverApproved(env)).toMatchObject({ kind: "found", files: [] });
	});
});

describe("parseLesson", () => {
	it("accepts the fixture", () => {
		const parsed = parseLesson(FIXTURE);
		expect(parsed.ok).toBe(true);
	});

	// The whole reason this is TypeScript. A lesson the API would reject fails
	// here first, against the same schema, with the same error - and there is no
	// second copy to drift.
	it("rejects a lesson the API would reject, naming the field", () => {
		const env = root();
		const bad = join(approvedDir(env), "bad.json");
		writeFileSync(bad, JSON.stringify({ id: "not-a-ulid", claim: "x" }));
		const parsed = parseLesson(bad);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.error).toMatch(/schema_version|rationale|id/);
	});

	it("reports unreadable JSON without throwing", () => {
		const env = root();
		const broken = join(approvedDir(env), "broken.json");
		writeFileSync(broken, "{ not json");
		expect(parseLesson(broken).ok).toBe(false);
	});
});

describe("batch", () => {
	it("never exceeds the server's limit", () => {
		const batches = batch(Array.from({ length: 250 }, (_, i) => i), MAX_BATCH);
		expect(batches).toHaveLength(3);
		expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(100);
	});

	it("returns nothing for nothing", () => {
		expect(batch([], MAX_BATCH)).toEqual([]);
	});
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/lessons.test.ts`
Expected: FAIL — `Failed to resolve import "../lessons"`.

- [ ] **Step 4: Write the implementation**

`apps/cli/src/lessons.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ZLesson, type TLesson } from "@onlooker-community/lesson-contract";
import { onlookerDir } from "./config";

/** The server's own ceiling. A larger batch comes back 400 `batch_too_large`. */
export const MAX_BATCH = 100;

/**
 * What a look at the disk found.
 *
 * Three outcomes rather than an array, because "no lessons" has three causes
 * that deserve different sentences: the directory does not exist, the ecosystem
 * has never run here, or there is genuinely nothing approved yet. The last is
 * the expected state until the promotion step ships, so a bare empty array
 * would make the normal case indistinguishable from a broken install.
 */
export type Discovery =
	| { kind: "no-onlooker-dir"; path: string }
	| { kind: "no-librarian-dir"; path: string }
	| { kind: "found"; files: string[] };

export function discoverApproved(
	env: NodeJS.ProcessEnv = process.env,
): Discovery {
	const root = onlookerDir(env);
	if (!existsSync(root)) return { kind: "no-onlooker-dir", path: root };

	const librarian = join(root, "librarian");
	if (!existsSync(librarian)) {
		return { kind: "no-librarian-dir", path: librarian };
	}

	// librarian/<12-hex project key>/lessons/approved/*.json. An explicit path
	// rather than a recursive walk: lessons have exactly one home, and naming it
	// is what lets the three outcomes above stay distinguishable.
	//
	// `approved` only. `proposals/` holds candidates awaiting judgment, and
	// pushing one would put an unjudged claim into a pool built on consensus.
	const files: string[] = [];
	for (const project of readdirSync(librarian)) {
		const approved = join(librarian, project, "lessons", "approved");
		if (!existsSync(approved)) continue;
		for (const entry of readdirSync(approved)) {
			if (entry.endsWith(".json")) files.push(join(approved, entry));
		}
	}
	return { kind: "found", files: files.sort() };
}

export type Parsed =
	| { ok: true; lesson: TLesson }
	| { ok: false; file: string; error: string };

/**
 * Read one lesson and hold it to the same schema apps/api holds it to.
 *
 * `ZLesson` is imported rather than reimplemented, which is the argument for
 * writing this in TypeScript at all: a lesson the API would reject fails here
 * first, with the same message, and there is no second copy of the schema free
 * to drift from the first.
 */
export function parseLesson(file: string): Parsed {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { ok: false, file, error: (error as Error).message };
	}

	const result = ZLesson.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		return {
			ok: false,
			file,
			error: `${first.path.join(".") || "(root)"}: ${first.message}`,
		};
	}
	return { ok: true, lesson: result.data };
}

export function batch<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/lessons.test.ts`
Expected: PASS, 11 tests. If the `@onlooker-community/lesson-contract` import fails to resolve, run `pnpm build` once — that package publishes types from `dist/` and turbo's `typecheck` depends on `^typecheck`, not `^build`.

- [ ] **Step 6: Run the full gates, then commit**

Subject: `feat(cli): find approved lessons and hold them to the contract :books:`
Body: why three discovery outcomes rather than an array, why `proposals/` is never read, and why `ZLesson` is imported rather than reimplemented.

---

### Task 5: `onlooker sync`

**Files:**
- Create: `apps/cli/src/commands/sync.ts`, `apps/cli/src/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `readConfig` from `../config`; `createClient`, `ApiError` from `../api`; `discoverApproved`, `parseLesson`, `batch`, `MAX_BATCH` from `../lessons`.
- Produces: `sync(deps: SyncDeps): Promise<string>` — resolves with the report when every lesson landed, and throws an `ApiError` when any did not. where `interface SyncDeps { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }`. Task 6's dispatcher calls it.

- [ ] **Step 1: Write the failing test**

`apps/cli/src/__tests__/sync.test.ts`:

```ts
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeConfig } from "../config";
import { sync } from "../commands/sync";

const FIXTURE = join(__dirname, "fixtures", "lesson.json");

function linked(): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-sync-")) };
	writeConfig({ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" }, env);
	return env;
}

function withLessons(env: NodeJS.ProcessEnv, count: number): void {
	const dir = join(env.ONLOOKER_DIR as string, "librarian", "4c1de90ab372", "lessons", "approved");
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < count; i++) cpSync(FIXTURE, join(dir, `lesson-${i}.json`));
}

const accepts = () =>
	vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [] }) });

/** A 200 whose body carries the given per-lesson outcomes. */
const pushes = (results: Array<{ id: string; outcome: string; error?: string }>) =>
	vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ results }) });

describe("sync", () => {
	it("refuses to run before the machine is linked", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-unlinked-")) };
		await expect(sync({ env, fetchImpl: accepts() })).rejects.toThrow(/onlooker link/);
	});

	// The common path until the ecosystem's promotion step ships. Exiting
	// successfully with a clear sentence is the correct behavior, not an edge
	// case - and it must not look like a failure.
	it("succeeds with nothing to do when no lesson is approved", async () => {
		const env = linked();
		mkdirSync(join(env.ONLOOKER_DIR as string, "librarian"), { recursive: true });
		const fetchImpl = accepts();
		const message = await sync({ env, fetchImpl });
		expect(message).toMatch(/nothing to sync/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("says where it looked when the ecosystem has never run here", async () => {
		const message = await sync({ env: linked(), fetchImpl: accepts() });
		expect(message).toMatch(/librarian/);
	});

	it("pushes what it finds", async () => {
		const env = linked();
		withLessons(env, 2);
		const fetchImpl = accepts();
		await sync({ env, fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body).lessons).toHaveLength(2);
	});

	it("never exceeds the server's batch ceiling", async () => {
		const env = linked();
		withLessons(env, 150);
		const fetchImpl = accepts();
		await sync({ env, fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		for (const [, init] of fetchImpl.mock.calls) {
			expect(JSON.parse(init.body).lessons.length).toBeLessThanOrEqual(100);
		}
	});

	// Re-running is free because the server dedupes by id. Reporting `noop`
	// separately is what tells the user that, rather than leaving a second run
	// looking like it did the same work twice.
	it("distinguishes newly created lessons from ones already held", async () => {
		const env = linked();
		withLessons(env, 2);
		const fetchImpl = pushes([
			{ id: "a", outcome: "created" },
			{ id: "b", outcome: "noop" },
		]);
		const message = await sync({ env, fetchImpl });
		expect(message).toMatch(/1 new/);
		expect(message).toMatch(/1 already/);
	});

	// The API answers with five outcomes, not two, and its own source warns
	// that conflating them loses lessons: `invalid` means stop sending this,
	// `error` means retry it. Counting anything that is not `created` as
	// "already in the pool" would report a lesson that failed to store as one
	// that synced - the exact defect this CLI exists to remove.
	it("does not report a failed lesson as one already in the pool", async () => {
		const env = linked();
		withLessons(env, 1);
		const fetchImpl = pushes([
			{ id: "c", outcome: "error", error: "The lesson was not stored; retry it" },
		]);
		await expect(sync({ env, fetchImpl })).rejects.toThrow(/retry/i);
	});

	// `invalid` will never succeed, so it must not be reported as retryable.
	// The dispatcher turns a transient failure into exit 2 and everything else
	// into exit 1; getting this wrong tells a script to retry forever.
	it("reports an invalid lesson as terminal, naming the lesson", async () => {
		const env = linked();
		withLessons(env, 1);
		const fetchImpl = pushes([
			{ id: "01KZ45MKAM734ZS7JK24D2DK0R", outcome: "invalid", error: "id must be a ULID" },
		]);
		await expect(sync({ env, fetchImpl })).rejects.toMatchObject({
			failure: { kind: "rejected" },
		});
		await expect(sync({ env, fetchImpl })).rejects.toThrow(/01KZ45MKAM734ZS7JK24D2DK0R/);
	});

	// A conflict means the pool holds a different version under the same id.
	// Silently counting it as synced would hide a real divergence.
	it("surfaces a conflict rather than counting it as synced", async () => {
		const env = linked();
		withLessons(env, 1);
		const fetchImpl = pushes([{ id: "d", outcome: "conflict" }]);
		await expect(sync({ env, fetchImpl })).rejects.toThrow(/conflict|different/i);
	});

	// A file the contract rejects is reported and skipped. Aborting the run would
	// let one malformed lesson block every valid one behind it.
	it("skips an invalid lesson and pushes the rest", async () => {
		const env = linked();
		withLessons(env, 1);
		const dir = join(env.ONLOOKER_DIR as string, "librarian", "4c1de90ab372", "lessons", "approved");
		require("node:fs").writeFileSync(join(dir, "zz-bad.json"), "{}");
		const fetchImpl = accepts();
		const message = await sync({ env, fetchImpl });
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body).lessons).toHaveLength(1);
		expect(message).toMatch(/1 skipped/);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/sync.test.ts`
Expected: FAIL — `Failed to resolve import "../commands/sync"`.

- [ ] **Step 3: Write the implementation**

`apps/cli/src/commands/sync.ts`:

```ts
import { ApiError, createClient } from "../api";
import { readConfig } from "../config";
import { batch, discoverApproved, MAX_BATCH, parseLesson } from "../lessons";

export interface SyncDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

/**
 * Push every approved lesson to the pool.
 *
 * Stateless on purpose. `createLessonsWithFeed` answers `created` or `taken` per
 * lesson, so an id the server already holds comes back `taken` rather than as an
 * error - which means re-running is free and a crashed run just runs again. That
 * removes the buffer, the cursor and the watermark the retired CLI carried, and
 * with them the failure where a dead endpoint filled a database forever.
 */
export async function sync({
	env = process.env,
	fetchImpl,
}: SyncDeps): Promise<string> {
	const config = readConfig(env);
	if (!config.machineToken) {
		throw new Error(
			"This machine is not linked. Mint a token on the Machines page and run `onlooker link`.",
		);
	}

	const found = discoverApproved(env);
	if (found.kind === "no-onlooker-dir") {
		return `Nothing to sync: ${found.path} does not exist, so no plugin has run here yet.`;
	}
	if (found.kind === "no-librarian-dir") {
		return `Nothing to sync: ${found.path} does not exist, so librarian has not run here yet.`;
	}
	if (found.files.length === 0) {
		return "Nothing to sync: no approved lessons yet.";
	}

	const lessons = [];
	const skipped: string[] = [];
	for (const file of found.files) {
		const parsed = parseLesson(file);
		// One malformed file does not stop the run. Aborting would let a single
		// bad lesson block every valid one behind it, and the file name plus the
		// failing field is enough to go fix it.
		if (parsed.ok) lessons.push(parsed.lesson);
		else skipped.push(`${parsed.file}: ${parsed.error}`);
	}

	const client = createClient(config.apiBaseUrl, config.machineToken, fetchImpl);
	let created = 0;
	let unchanged = 0;
	// Split rather than lumped, because the API distinguishes "never send this
	// again" from "send it again in a minute" and the exit code has to carry
	// that difference out to whatever called us.
	const terminal: string[] = [];
	const retryable: string[] = [];

	for (const chunk of batch(lessons, MAX_BATCH)) {
		const response = await client.push(chunk);
		for (const result of response.results ?? []) {
			switch (result.outcome) {
				case "created":
					created++;
					break;
				case "noop":
					unchanged++;
					break;
				case "conflict":
					// Same id, different content. Not a failure to store, but not a
					// success either - the pool and this machine disagree, and only a
					// person can say which is right.
					terminal.push(`${result.id}: the pool holds a different version`);
					break;
				case "invalid":
					terminal.push(`${result.id}: rejected - ${result.error ?? "no reason given"}`);
					break;
				default:
					// `error`, and anything a future API adds. Treated as retryable
					// because that is the safe direction to be wrong in: retrying a
					// lesson the server already holds costs one deduped request, while
					// discarding one the server never stored loses it for good.
					retryable.push(`${result.id}: ${result.error ?? "not stored; retry it"}`);
			}
		}
	}

	const counts = [`${created} new`, `${unchanged} already in the pool`];
	if (skipped.length > 0) counts.push(`${skipped.length} skipped`);
	const summary = `Synced ${lessons.length} lessons: ${counts.join(", ")}.`;

	// A lesson the server did not store must never be reported as one it did.
	// Counting every non-`created` outcome as "already in the pool" is exactly
	// how the retired CLI turned a failure into a success message.
	if (retryable.length > 0) {
		throw new ApiError({
			kind: "transient",
			message: [`${retryable.length} lesson(s) were not stored. Run sync again.`, ...retryable].join("\n"),
		});
	}
	if (terminal.length > 0) {
		throw new ApiError({
			kind: "rejected",
			message: [`${terminal.length} lesson(s) were refused.`, ...terminal].join("\n"),
		});
	}

	return [summary, ...skipped].join("\n");
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/sync.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full gates, then commit**

Subject: `feat(cli): push approved lessons to the pool :outbox_tray:`
Body: why the sync keeps no state, why an invalid lesson is skipped rather than fatal, and why "nothing to sync" is a success.

---

### Task 6: `onlooker status`, and the dispatcher

**Files:**
- Create: `apps/cli/src/commands/status.ts`, `apps/cli/src/main.ts`, `apps/cli/src/__tests__/status.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `status(deps: StatusDeps): Promise<string>`; `main.ts` as the bundle's entry point.

- [ ] **Step 1: Write the failing test**

`apps/cli/src/__tests__/status.test.ts`:

```ts
import { mkdirSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeConfig } from "../config";
import { status } from "../commands/status";

const FIXTURE = join(__dirname, "fixtures", "lesson.json");
const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ lessons: [] }) });

describe("status", () => {
	it("says so when nothing is linked, without calling the API", async () => {
		const fetchImpl = ok();
		const message = await status({
			env: { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) },
			fetchImpl,
		});
		expect(message).toMatch(/not linked/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// A stored token that no longer authenticates is the case worth catching -
	// it looks linked until something tries to use it.
	it("reports a stored token that no longer works", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig({ apiBaseUrl: "https://api.onlooker.dev", machineToken: "stale" }, env);
		const rejects = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
		const message = await status({ env, fetchImpl: rejects });
		expect(message).toMatch(/rejected|no longer/i);
	});

	it("counts approved lessons waiting to go", async () => {
		const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-st-")) };
		writeConfig({ apiBaseUrl: "https://api.onlooker.dev", machineToken: "tok" }, env);
		const dir = join(env.ONLOOKER_DIR as string, "librarian", "k", "lessons", "approved");
		mkdirSync(dir, { recursive: true });
		cpSync(FIXTURE, join(dir, "a.json"));
		expect(await status({ env, fetchImpl: ok() })).toMatch(/1 approved lesson/);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/cli exec vitest run src/__tests__/status.test.ts`
Expected: FAIL — `Failed to resolve import "../commands/status"`.

- [ ] **Step 3: Write `status`**

`apps/cli/src/commands/status.ts`:

```ts
import { ApiError, createClient } from "../api";
import { configPath, readConfig } from "../config";
import { discoverApproved } from "../lessons";

export interface StatusDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

/** What is linked, whether it still works, and what is waiting to be sent. */
export async function status({
	env = process.env,
	fetchImpl,
}: StatusDeps): Promise<string> {
	const config = readConfig(env);
	const lines = [`API:    ${config.apiBaseUrl}`, `Config: ${configPath(env)}`];

	if (!config.machineToken) {
		lines.push("Token:  not linked - run `onlooker link`");
	} else {
		try {
			await createClient(config.apiBaseUrl, config.machineToken, fetchImpl).verify();
			lines.push("Token:  accepted");
		} catch (error) {
			// A stored token that stopped working is the case worth surfacing: it
			// looks linked right up until something tries to use it.
			const detail =
				error instanceof ApiError ? error.failure.message : (error as Error).message;
			lines.push(`Token:  rejected - ${detail}`);
		}
	}

	const found = discoverApproved(env);
	if (found.kind === "no-onlooker-dir") {
		lines.push(`Lessons: none - ${found.path} does not exist`);
	} else if (found.kind === "no-librarian-dir") {
		lines.push(`Lessons: none - ${found.path} does not exist`);
	} else {
		const n = found.files.length;
		lines.push(`Lessons: ${n} approved lesson${n === 1 ? "" : "s"} ready to sync`);
	}

	return lines.join("\n");
}
```

- [ ] **Step 4: Write the dispatcher**

`apps/cli/src/main.ts`:

```ts
import { createInterface } from "node:readline/promises";
import { ApiError } from "./api";
import { link } from "./commands/link";
import { status } from "./commands/status";
import { sync } from "./commands/sync";

// No argument-parsing library. Three commands and no flags do not justify one,
// and a switch is easier to read than the framework would be.
const USAGE = `onlooker - push approved lessons to app.onlooker.dev

  onlooker link     connect this machine with a token from the Machines page
  onlooker sync     push every approved lesson
  onlooker status   what is linked, and what is waiting
`;

/**
 * Read a credential without putting it on screen.
 *
 * A pasted machine token is shown once and recoverable only by revoking the
 * machine, so it should not survive in the scrollback. Reading stdin when it is
 * not a TTY also lets `echo "$TOKEN" | onlooker link` work in a script.
 */
async function promptForToken(): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks).toString("utf8");
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// Suppress the echo of typed characters while still writing the prompt.
	//
	// `_writeToOutput` is readline's internal line-refresh hook, not public API.
	// Verified present on the Interface prototype in Node 24.13.0, and verified
	// under a real PTY that assigning it on the instance does suppress the echo.
	// The prompt is written first, deliberately: after the override nothing
	// reaches the terminal, including the prompt itself.
	const internals = rl as unknown as { _writeToOutput?: (s: string) => void };
	process.stdout.write("Machine token: ");
	internals._writeToOutput = () => {};
	try {
		return await rl.question("");
	} catch (error) {
		// Ctrl+D rejects the question with an AbortError. That is a person saying
		// "never mind" at a credential prompt - one of the two normal ways to back
		// out - and letting it propagate prints a Node stack trace instead.
		// Returning empty routes it into the same "No token entered" message an
		// empty paste gets. Confirmed against Node 24.13.0, which rejects with
		// `AbortError: Aborted with Ctrl+D`.
		if ((error as Error)?.name === "AbortError") return "";
		throw error;
	} finally {
		rl.close();
		process.stdout.write("\n");
	}
}

/**
 * Exit codes carry the same distinction the messages do: 1 for something the
 * user must change, 2 for something a retry may fix. A script wrapping this can
 * then tell "stop and go look" from "try again later" without parsing text.
 */
async function run(argv: string[]): Promise<number> {
	const command = argv[2];
	try {
		if (command === "link") {
			console.log(await link({ prompt: promptForToken }));
		} else if (command === "sync") {
			console.log(await sync({}));
		} else if (command === "status") {
			console.log(await status({}));
		} else {
			console.log(USAGE);
			return command === undefined || command === "--help" ? 0 : 1;
		}
		return 0;
	} catch (error) {
		const failure = error instanceof ApiError ? error.failure : undefined;
		console.error(failure ? failure.message : (error as Error).message);
		return failure?.kind === "transient" ? 2 : 1;
	}
}

process.exitCode = await run(process.argv);
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/cli exec vitest run`
Expected: PASS, 3 new tests and every earlier one still green.

- [ ] **Step 6: Prove it end to end against the fixture**

This is the step Section 7 of the spec calls for, and the only thing that exercises the whole path while `approved/` has no producer. From the repo root:

```bash
pnpm --filter @onlooker/cli build
export ONLOOKER_DIR=$(mktemp -d)
mkdir -p "$ONLOOKER_DIR/librarian/4c1de90ab372/lessons/approved"
cp apps/cli/src/__tests__/fixtures/lesson.json "$ONLOOKER_DIR/librarian/4c1de90ab372/lessons/approved/"
node apps/cli/dist/onlooker.mjs status
```

Expected: it reports the API, the config path, `not linked`, and `1 approved lesson ready to sync`. **Record the actual output in your report.** Do not link against production in this step — that requires a real token, and the point here is that discovery and reporting work.

- [ ] **Step 7: Run the full gates, then commit**

Subject: `feat(cli): report what is linked and what is waiting :mag:`
Body: why exit code 2 means retryable, why the token prompt suppresses echo, and why there is no argument-parsing dependency.

---

### Task 7: Ship it

**Files:**
- Create: `.github/workflows/release-cli.yml`, `scripts/write-formula.mjs`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `apps/cli`'s `build` script from Task 1.
- Produces: a tagged GitHub release carrying `onlooker-<version>.tar.gz`, and a formula written from it.

- [ ] **Step 1: Stop a CLI commit from deploying production**

`.github/workflows/deploy.yml` is the repository's **only** CI workflow. Its
`quality` job runs lint, typecheck and four shell test suites; its `test` job
runs `pnpm build` and `pnpm test`. So the triggers must stay unfiltered — every
change, including a CLI-only one, has to keep running CI.

What must not happen is the *deploy*. `deploy-staging` and `deploy-production`
run `wrangler deploy` for the API, web and website; a CLI-only merge would
redeploy identical code, and `concurrency.cancel-in-progress: true` means it can
cancel a deploy already in flight.

So gate the jobs, not the trigger. **Leave `on:` exactly as it is.** Add a
`changes` job before `deploy-staging`:

```yaml
  changes:
    name: Which surfaces changed
    runs-on: ubuntu-latest
    outputs:
      deployable: ${{ steps.filter.outputs.deployable }}
    steps:
      - uses: actions/checkout@v5
        with:
          # Needed to diff against the pre-push commit; the default shallow
          # fetch does not have it.
          fetch-depth: 0

      - name: Decide whether anything deployable changed
        id: filter
        run: |
          # A plain diff rather than a third-party paths-filter action: every
          # other action in this workflow is an official actions/* one, and
          # this is a dozen lines of shell.
          BEFORE="${{ github.event.before }}"
          if [ -z "$BEFORE" ] || [ "$BEFORE" = "0000000000000000000000000000000000000000" ]; then
            # First push to the branch, or a force-push with no usable base.
            # Deploy rather than guess: a redundant deploy is cheap, a skipped
            # one ships nothing.
            echo "deployable=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          CHANGED=$(git diff --name-only "$BEFORE" "${{ github.sha }}")
          echo "$CHANGED"
          if echo "$CHANGED" | grep -qE '^(apps/(api|web|website)/|packages/|package\.json|pnpm-lock\.yaml|turbo\.json|\.github/workflows/deploy\.yml)'; then
            echo "deployable=true" >> "$GITHUB_OUTPUT"
          else
            echo "deployable=false" >> "$GITHUB_OUTPUT"
          fi
```

`packages/**` counts as deployable: the CLI shares `lesson-contract` with the
API, so a contract change must still reach production.

Then change `deploy-staging`'s two lines — currently `needs: test` and its `if:`
— to depend on both jobs and require a deployable change:

```yaml
    needs: [test, changes]
    # Staging tracks main. There is no long-lived staging branch to keep in sync,
    # and production below will not run unless this succeeds first.
    #
    # `changes.deployable` keeps a CLI-only merge from redeploying the API, web
    # and website with identical code - which matters because
    # concurrency.cancel-in-progress can cancel a deploy already in flight.
    if: >-
      github.ref == 'refs/heads/main'
      && github.event_name == 'push'
      && needs.changes.outputs.deployable == 'true'
```

**Leave `deploy-production` alone.** It already declares `needs: deploy-staging`
rather than `needs: test`, and GitHub skips a job whose dependency was skipped.
Gating staging therefore gates production, through the mechanism the existing
comment on that job already describes. Adding a second copy of the condition
would be duplication that can drift.

- [ ] **Step 2: Write the formula generator**

`scripts/write-formula.mjs`:

```js
#!/usr/bin/env node
// Writes the Homebrew formula for the CLI.
//
// Not goreleaser: that is Go-specific, and this CLI is a bundled JS file that
// runs on Homebrew's node. Usage:
//   node scripts/write-formula.mjs <version> <tarball-url> <sha256>

const [version, url, sha256] = process.argv.slice(2);
if (!version || !url || !sha256) {
	console.error("usage: write-formula.mjs <version> <url> <sha256>");
	process.exit(1);
}

process.stdout.write(`# typed: false
# frozen_string_literal: true

# Generated by scripts/write-formula.mjs. DO NOT EDIT.
class Onlooker < Formula
  desc "Push approved lessons from your machine to app.onlooker.dev"
  homepage "https://onlooker.dev"
  url "${url}"
  sha256 "${sha256}"
  version "${version}"
  license "BlueOak-1.0.0"

  depends_on "node"

  def install
    libexec.install "onlooker.mjs"
    (bin/"onlooker").write <<~SH
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/onlooker.mjs" "$@"
    SH
    chmod 0555, bin/"onlooker"
  end

  # No service block. This CLI has no daemon: it runs, syncs, and exits.
  # Anyone upgrading from the retired Go agent has a launchd job pointed at a
  # subcommand that no longer exists, and Homebrew cannot stop it for them.
  def caveats
    <<~EOS
      If you previously ran the Onlooker agent as a service, stop it:

        brew services stop onlooker

      This version has no daemon. Link once, then sync when you want to:

        onlooker link
        onlooker sync
    EOS
  end

  test do
    assert_match "onlooker", shell_output("#{bin}/onlooker --help")
  end
end
`);
```

- [ ] **Step 3: Write the release workflow**

`.github/workflows/release-cli.yml`:

```yaml
name: Release CLI

# Tag-driven and separate from deploy.yml on purpose: shipping the CLI must
# never start a Cloudflare deploy, and a Cloudflare deploy must never cut a
# CLI release.
on:
  push:
    tags:
      - "cli-v*"

jobs:
  release:
    name: Build and publish
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: '11.0.9'
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @onlooker/cli build

      - name: Package
        id: package
        run: |
          VERSION="${GITHUB_REF_NAME#cli-v}"
          tar -czf "onlooker-${VERSION}.tar.gz" -C apps/cli/dist onlooker.mjs
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"
          echo "sha256=$(shasum -a 256 "onlooker-${VERSION}.tar.gz" | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"

      - name: Publish the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${GITHUB_REF_NAME}" \
            "onlooker-${{ steps.package.outputs.version }}.tar.gz" \
            --title "CLI ${{ steps.package.outputs.version }}" \
            --notes "Push approved lessons to app.onlooker.dev."

      - name: Write the formula
        run: |
          node scripts/write-formula.mjs \
            "${{ steps.package.outputs.version }}" \
            "https://github.com/${{ github.repository }}/releases/download/${GITHUB_REF_NAME}/onlooker-${{ steps.package.outputs.version }}.tar.gz" \
            "${{ steps.package.outputs.sha256 }}" > onlooker.rb
          cat onlooker.rb

      - uses: actions/upload-artifact@v4
        with:
          name: formula
          path: onlooker.rb
```

The formula is uploaded rather than pushed to the tap. Pushing needs a cross-repository token, and the first release should be copied across by hand so someone reads it before `brew` does.

- [ ] **Step 4: Verify the generator locally**

```bash
node scripts/write-formula.mjs 2.0.0 https://example.invalid/onlooker-2.0.0.tar.gz abc123 > /tmp/onlooker.rb
grep -c 'depends_on "node"' /tmp/onlooker.rb   # expect 1
grep -c "service" /tmp/onlooker.rb              # expect 0 - no service block
grep -c "brew services stop" /tmp/onlooker.rb   # expect 1 - the caveat
```

Report the three counts. The middle one is the point: the retired formula's service block is what would otherwise leave launchd relaunching a binary that no longer takes `daemon`.

- [ ] **Step 5: Run the full gates, then commit**

Subject: `feat(cli): build, release and a formula that needs no daemon :package:`
Body: why `deploy.yml` gates the deploy job rather than the trigger, why the formula is generated rather than goreleased, and why the caveat exists.

---

## Closing out

```bash
pnpm test && pnpm typecheck && pnpm lint
git status
```

Open the PR with `/pr`. Do not push to `main`.

After merge, and only then:

1. Tag `cli-v2.0.0` to cut the first release.
2. Copy the generated `onlooker.rb` into `onlooker-community/homebrew-tap`, replacing the goreleaser-generated one.
3. Archive `onlooker-community/onlooker-cli` — **after** the formula flips, and by archiving rather than deleting, so its release assets stay downloadable.
4. `bd close onlooker-v72`. Leave `onlooker-33i` open until the formula is live, since that bug is only fixed once the new CLI is what `brew install` gets.

---

## Self-review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| §1 three commands, no daemon | 3, 5, 6 |
| §2 paste-based link, prompted not argued | 3, 6 |
| §2 verify against `GET /lessons`, never `/api/lessons` | 2 (pinned by test) |
| §3 explicit path, three discovery outcomes | 4 |
| §3 stateless sync, batches of ≤100 | 5 |
| all five `POST /lessons` outcomes handled distinctly | 2 (type), 5 (handling) |
| §3 error classification, four kinds | 2 |
| §4 TypeScript importing `ZLesson`; esbuild bundle | 1, 4 |
| §4 formula declares `depends_on "node"` | 7 |
| §5 formula keeps the name, drops the service block, gains a caveat | 7 |
| §5 version starts at 2.0.0 | 1, 7 |
| §5 a CLI commit must not deploy production | 7 (deploy jobs gated; triggers unfiltered so CI still runs) |
| §6 archive the old repo after the formula flips | Closing out |
| §7 validation parity, batching, error classification, idempotence | 2, 4, 5 |
| §7 formula version and sha256 match the artifact | 7 |
| §7 end-to-end against the fixture | 6 |
| §7 the empty case is a first-class outcome | 5 |

**Placeholder scan.** No TBDs. Every code step carries its code. Two steps ask the implementer to *report* rather than decide: the revert-check in Task 2 and the fixture run in Task 6.

**Type consistency.** `CliConfig`, `configPath`, `readConfig`, `writeConfig`, `onlookerDir` are defined in Task 1 and used under those names in 3, 4, 5 and 6. `Failure`, `ApiError`, `classify`, `createClient`, `ApiClient`, `PushResponse` are defined in Task 2 and used in 3, 5 and 6. `Discovery`, `discoverApproved`, `Parsed`, `parseLesson`, `batch`, `MAX_BATCH` are defined in Task 4 and used in 5 and 6. Every command takes a single deps object and returns the string to print, so Task 6's dispatcher treats all three identically.

**The risk named in this plan's first draft has now been tested.** `promptForToken`
reaches into `readline`'s internals to suppress echo, which is not documented API.
Measured on Node 24.13.0 before Task 6 was dispatched: `_writeToOutput` exists on
the Interface prototype, assigning it on the instance shadows it, and under a real
PTY the typed characters are genuinely not echoed. The same probe found that Ctrl+D
rejects with `AbortError: Aborted with Ctrl+D` and, unhandled, prints a stack trace
at a credential prompt — so the code above catches it and routes it into the same
"No token entered" path an empty paste takes.

It remains undocumented API. It is still guarded by the non-TTY path, so piping a
token in works regardless; if a future Node breaks it, the honest fallback is to
warn that the token will be visible and read it normally, never to silently echo a
credential.
