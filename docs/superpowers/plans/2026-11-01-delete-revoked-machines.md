# Deleting Revoked Machines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person delete a revoked machine from the Machines page, while its row and session history stay.

**Architecture:** A nullable `removed_at` column on `machine_tokens`. `POST /api/machines/:id/remove` sets it on a revoked row. `GET /api/machines` keeps returning removed rows, and `MachinesPage` filters them out, because the Sessions page needs them to name old sessions.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, drizzle, React, vitest.

Spec: `docs/superpowers/specs/2026-11-01-delete-revoked-machines-design.md`. Linear: ONL-231.

## Global Constraints

- Never hard-delete a `machine_tokens` row here: `session_summaries.machine_id` is `ON DELETE CASCADE`.
- Only a row that is this user's, revoked and not yet removed can be removed. Everything else answers `404 not_found` "No such machine".
- `GET /api/machines` returns removed rows, with `removed_at`. Only `MachinesPage` filters them. The Sessions page does not change.
- Page copy, exactly: trigger `Delete`, question `Delete <name>? Its sessions stay.`, confirm `Yes, delete`, pending `Deleting...`, status `Deleted <name>.`, error `Could not delete that machine.`
- Tests: run one API file with `pnpm --filter @onlooker/api test <name>`, with **no `--`**. The API's Workers pool does not apply `vi.mock`.
- Edit tracked files with Edit/Write, never `sed -i`, heredocs, `biome format --write` or `lint:fix`. Generated migration files come from the generators below.
- Commits: `<type>(<scope>): <subject> :emoji:`, subject ≤72 characters, American English, a why-focused body, `Refs ONL-231`.

---

### Task 1: The column, the route and the contract

**Files:**
- Modify: `packages/db/src/schema.ts` (the `machine_tokens` table)
- Create (generated): the next file in `packages/db/migrations`, its snapshot and journal entry, and the regenerated expected schema
- Modify: `apps/api/src/db/machine-tokens.ts`, `apps/api/src/db/machine-tokens.test.ts`
- Modify: `apps/api/src/routes/machines.ts`, `apps/api/src/routes/index.ts`, `apps/api/src/router.ts`
- Modify: `packages/api-contract/src/index.ts`, `apps/api/src/contract.test.ts`, `apps/web/src/api/api-contract.test.ts`
- Modify: `apps/web/src/api/mockApi.ts`, `apps/web/src/api/mockMachines.test.ts`, `apps/web/src/api/machinesApi.ts`

**Interfaces:**
- Produces: `removeMachineToken(db, userId, id): Promise<boolean>`; `MachineTokenSummary.removed_at: string | null`; web `Machine.removed_at: string | null`; web `removeMachine(id): Promise<{ success: boolean }>`

- [ ] **Step 1: Write the failing DB tests**

In `apps/api/src/db/machine-tokens.test.ts`, import `removeMachineToken`, and add:

```ts
describe("removeMachineToken", () => {
	it("marks a revoked machine removed, and the list still returns it", async () => {
		const { id } = await createMachineToken(db(), userId, "old laptop");
		await revokeMachineToken(db(), userId, id);

		expect(await removeMachineToken(db(), userId, id)).toBe(true);

		const [machine] = await listMachineTokens(db(), userId);
		expect(machine?.id).toBe(id);
		expect(machine?.removed_at).not.toBeNull();
	});

	// A live credential must not vanish from the page while it still works.
	it("will not remove a live machine", async () => {
		const { id } = await createMachineToken(db(), userId, "live");

		expect(await removeMachineToken(db(), userId, id)).toBe(false);
		const [machine] = await listMachineTokens(db(), userId);
		expect(machine?.removed_at).toBeNull();
	});

	it("will not remove a machine belonging to someone else", async () => {
		const other = await createUser(db(), "b@example.com", "hash", "Bob");
		const { id } = await createMachineToken(db(), userId, "mine");
		await revokeMachineToken(db(), userId, id);

		expect(await removeMachineToken(db(), other.id, id)).toBe(false);
		const [machine] = await listMachineTokens(db(), userId);
		expect(machine?.removed_at).toBeNull();
	});

	it("will not remove a machine twice, or one that never existed", async () => {
		const { id } = await createMachineToken(db(), userId, "old");
		await revokeMachineToken(db(), userId, id);
		await removeMachineToken(db(), userId, id);

		expect(await removeMachineToken(db(), userId, id)).toBe(false);
		expect(await removeMachineToken(db(), userId, "no-such-id")).toBe(false);
	});
});
```

Add one more test in that block, `"keeps the sessions the machine reported"`: store a summary for the machine using the exported store function in `apps/api/src/db/session-summaries.ts` (see its doc comment at about line 55, and copy a fixture from an existing test that calls it), revoke, remove, then assert the `session_summaries` row for that `machine_id` still exists. This test exists to catch a future hard delete, so also clear `session_summaries` in this file's `beforeEach` if rows would leak.

- [ ] **Step 2: Add the column and generate the migration**

In `packages/db/src/schema.ts`, after `revoked_at: text("revoked_at"),`, add:

```ts
		/**
		 * When its owner deleted it from the Machines page. Null means it shows.
		 *
		 * A mark rather than a delete: session_summaries.machine_id cascades, so
		 * deleting this row would erase the machine's session history. Set only on
		 * a revoked row, so it never hides a working credential.
		 */
		removed_at: text("removed_at"),
```

Run: `pnpm --filter @onlooker/db generate:migrations`, then `pnpm --filter @onlooker/db build`, then `pnpm --filter @onlooker/db generate:expected-schema`.
Expected: one new migration adding `removed_at`, and an updated expected schema.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `pnpm --filter @onlooker/api test machine-tokens`
Expected: FAIL, because `removeMachineToken` is not defined.

- [ ] **Step 4: Implement the query**

In `apps/api/src/db/machine-tokens.ts`:

1. Import `isNotNull` from `drizzle-orm`.
2. Add `removed_at: string | null;` to `MachineTokenSummary`, after `revoked_at`, with the doc comment `/** When its owner deleted it from the Machines page. Listed anyway: the Sessions page still names it. */`.
3. Add `removed_at: machine_tokens.removed_at,` to the select in `listMachineTokens`, and change that function's doc comment to say "revoked and removed ones included".
4. After `revokeMachineToken`, add:

```ts
/**
 * Take a revoked machine off the Machines page. Returns false when the token
 * does not exist, belongs to someone else, is still live or is already removed.
 * The caller cannot tell those apart, which is deliberate.
 *
 * A mark rather than a DELETE: session_summaries.machine_id cascades, so
 * deleting the row would erase the machine's session history.
 */
export async function removeMachineToken(
	db: D1Database,
	userId: string,
	id: string,
): Promise<boolean> {
	const result = await client(db)
		.update(machine_tokens)
		.set({ removed_at: new Date().toISOString() })
		.where(
			and(
				eq(machine_tokens.id, id),
				eq(machine_tokens.user_id, userId),
				isNotNull(machine_tokens.revoked_at),
				isNull(machine_tokens.removed_at),
			),
		)
		.returning({ id: machine_tokens.id });

	return result.length > 0;
}
```

Run: `pnpm --filter @onlooker/api test machine-tokens`
Expected: PASS.

- [ ] **Step 5: Write the contract**

In `packages/api-contract/src/index.ts`, add `"removed_at"` to `MACHINE_LIFECYCLE.listFields`, and add after `revokeTwice`:

```ts
	/** Deleting a revoked machine from the page succeeds. */
	removeRevoked: 200,
	/** A live machine cannot be removed: it would vanish while still working. */
	removeLive: 404,
	/** Removing twice answers 404, as revoking twice does. */
	removeTwice: 404,
	/** 404 and not 403, for revokeSomeoneElses's reason. */
	removeSomeoneElses: 404,
```

Add this test to the machine lifecycle `describe` in `apps/api/src/contract.test.ts`, directly after `"will not let one account revoke another's machine"`:

```ts
	it("removes only a revoked machine of your own, once", async () => {
		const { id } = (await (await mint(owner, "old laptop")).json()) as {
			id: string;
		};
		const remove = (who: typeof owner) =>
			SELF.fetch(
				`${BASE}/api/machines/${id}/remove`,
				as(who, { method: "POST" }),
			);

		expect((await remove(owner)).status).toBe(MACHINE_LIFECYCLE.removeLive);

		await SELF.fetch(
			`${BASE}/api/machines/${id}`,
			as(owner, { method: "DELETE" }),
		);

		expect((await remove(stranger)).status).toBe(
			MACHINE_LIFECYCLE.removeSomeoneElses,
		);
		expect((await remove(owner)).status).toBe(MACHINE_LIFECYCLE.removeRevoked);
		expect((await remove(owner)).status).toBe(MACHINE_LIFECYCLE.removeTwice);
	});
```

Add the same test to `apps/web/src/api/api-contract.test.ts`, in its matching `describe`, in that file's idiom: `call(`/api/machines/${id}/remove`, as(who, { method: "POST" }))`. If the type of `owner` differs there, use that file's type.

- [ ] **Step 6: Implement the route and the mock**

In `apps/api/src/routes/machines.ts`, import `removeMachineToken`, and add after `handleRevokeMachine`:

```ts
export async function handleRemoveMachine(
	_request: Request,
	env: WorkerEnv,
	params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;

	// 404 for all of it, as handleRevokeMachine answers, so this cannot be used
	// to learn which ids exist or which of someone else's are revoked.
	if (!(await removeMachineToken(env.DB, userId, params.id))) {
		throw new ApiError(404, "not_found", "No such machine");
	}

	return Response.json({ success: true });
}
```

Export it from `apps/api/src/routes/index.ts` and import it in `apps/api/src/router.ts`, keeping their sorted order. In `router.ts`, add after the `DELETE /api/machines/:id` route:

```ts
	{
		method: "POST",
		path: "/api/machines/:id/remove",
		auth: "session",
		cors: "app",
		handler: handleRemoveMachine,
	},
```

In `apps/web/src/api/mockApi.ts`:

1. Add `removed_at: string | null;` to `MockMachine` after `revoked_at`, and `removed_at: null,` where machines are created.
2. Check that the list route's mapping includes `removed_at`; if it builds an explicit object, add it there.
3. Before the `/inventory` branch, add:

```ts
	if (
		poolPath.startsWith("/api/machines/") &&
		poolPath.endsWith("/remove") &&
		options.method === "POST"
	) {
		const { email } = requireAuth(options);
		const id = poolPath.slice("/api/machines/".length, -"/remove".length);
		const machine = machinesOf(email).find(
			(candidate) =>
				candidate.id === id && candidate.revoked_at && !candidate.removed_at,
		);
		// 404 for all of it, matching handleRemoveMachine.
		if (!machine) {
			throw new AuthApiError(404, "not_found", "No such machine");
		}
		machine.removed_at = new Date().toISOString();
		return json({ success: true });
	}
```

In `apps/web/src/api/machinesApi.ts`, add `removed_at: string | null;` to `Machine` after `revoked_at`, with a doc comment saying only `MachinesPage` hides these and that the Sessions page still needs them to name old sessions. Then add after `revokeMachine`:

```ts
export function removeMachine(id: string): Promise<{ success: boolean }> {
	return apiClient.post<{ success: boolean }>(
		`${MACHINE_ENDPOINTS.machines}/${encodeURIComponent(id)}/remove`,
		{},
	);
}
```

Match `apiClient.post`'s actual signature. Add a test to `apps/web/src/api/mockMachines.test.ts`, in its existing style, that a machine is listed with `removed_at` set after a revoke and a remove.

- [ ] **Step 7: Run everything this task touches**

Run: `pnpm --filter @onlooker/api test machine`, `pnpm --filter @onlooker/api test contract`, `pnpm --filter @onlooker/api test schema-drift`, `pnpm --filter @onlooker/web test api-contract`, `pnpm --filter @onlooker/web test mockMachines`, `pnpm typecheck`, `pnpm --filter @onlooker/api lint`.
Expected: all pass. If the web package's name or test script differs, use what `apps/web/package.json` says.

- [ ] **Step 8: Commit**

Stage the named files and the generated migration files, with a message like:

```
feat(api): remove a revoked machine without losing its sessions :wastebasket:

A real delete would cascade to the machine's session history, so removal is
a mark. Only a revoked row qualifies, so a working credential cannot vanish
from the page.

Refs ONL-231
```

---

### Task 2: The page

**Files:**
- Modify: `apps/web/src/pages/MachinesPage.tsx`
- Modify: `apps/web/src/__tests__/machines-page.test.tsx`
- Modify: `apps/web/src/__tests__/sessions-page.test.tsx`

**Interfaces:**
- Consumes: `removeMachine(id)` and `Machine.removed_at` from Task 1.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/__tests__/machines-page.test.tsx`:

1. Add `removeMachine: vi.fn()` to `mocks`, `removeMachine: mocks.removeMachine` to the `vi.mock`, and `mocks.removeMachine.mockReset();` beside the other resets.

2. Change the existing test `"keeps a revoked machine visible and gives it nothing to do"` (about line 419): rename it `"keeps a revoked machine visible and offers only Delete"`, keep its assertion that Revoke is gone, and assert a `Delete` button is there. Read the test first, and keep whatever else it pins.

3. Add this `describe`:

```tsx
describe("MachinesPage deleting a revoked machine", () => {
	const deleteIt = async () => {
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
	};

	it("offers Delete on a revoked row and not on a live one", async () => {
		withMachines(USED);
		await renderPage();
		await screen.findByRole("button", { name: "Revoke" });
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
	});

	it("asks first, and says the sessions stay", async () => {
		withMachines(REVOKED);
		await renderPage();
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		expect(
			screen.getByText(`Delete ${REVOKED.name}? Its sessions stay.`),
		).toBeDefined();
		expect(mocks.removeMachine).not.toHaveBeenCalled();
	});

	// Revoke's confirm and Delete's sit in the same slot. Without a key React
	// reuses the armed one, and a person who just said "Yes, revoke" would be
	// standing on "Yes, delete".
	it("does not carry an armed revoke confirm over to Delete", async () => {
		withMachines(USED);
		mocks.revokeMachine.mockResolvedValue({ success: true });
		await renderPage();
		fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
		withMachines({ ...USED, revoked_at: "2026-09-07T00:00:00.000Z" });
		fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));

		await screen.findByRole("button", { name: "Delete" });
		expect(screen.queryByRole("button", { name: "Yes, delete" })).toBeNull();
	});

	it("removes the row, announces it and moves focus to the status region", async () => {
		withMachines(USED, REVOKED);
		mocks.removeMachine.mockResolvedValue({ success: true });
		await renderPage();
		await screen.findByText(REVOKED.name);
		withMachines(USED, { ...REVOKED, removed_at: "2026-09-07T00:00:00.000Z" });

		await deleteIt();

		await waitFor(() => expect(screen.queryByText(REVOKED.name)).toBeNull());
		expect(mocks.removeMachine).toHaveBeenCalledWith(REVOKED.id);
		const status = screen.getByRole("status");
		expect(status.textContent).toBe(`Deleted ${REVOKED.name}.`);
		expect(document.activeElement).toBe(status);
	});

	it("does not show a machine that was already removed", async () => {
		withMachines(USED, { ...REVOKED, removed_at: "2026-09-07T00:00:00.000Z" });
		await renderPage();
		await screen.findByText(USED.name);
		expect(screen.queryByText(REVOKED.name)).toBeNull();
	});

	it("shows the empty state when every machine is removed", async () => {
		withMachines({ ...REVOKED, removed_at: "2026-09-07T00:00:00.000Z" });
		await renderPage();
		expect(await screen.findByText("No machines yet")).toBeDefined();
	});

	it("keeps the row and says so when the delete fails", async () => {
		withMachines(REVOKED);
		mocks.removeMachine.mockRejectedValue(new Error("boom"));
		await renderPage();

		await deleteIt();

		expect(await screen.findByRole("alert")).toBeDefined();
		expect(screen.getByText(REVOKED.name)).toBeDefined();
		expect(screen.getByRole("status").textContent).toBe("");
	});
});
```

Check `withMachines`' signature (about line 87) and `renderPage`, and adapt the calls if they differ. If `describeError` shows a different message for a plain `Error`, the `findByRole("alert")` still holds.

4. In `describe("MachinesPage when a revoke lands under an open reveal", …)`, add a test copied from `"holds the announcement until the reveal is dismissed"`, using `REVOKED`, `mocks.removeMachine`, the Delete and Yes, delete buttons, the row returned with `removed_at` set, and expecting `Deleted stolen laptop.`

In `apps/web/src/__tests__/sessions-page.test.tsx`, after `"falls back when a session's machine is no longer listed"`, add a test that a machine with `removed_at` set is still named. Copy the setup of the test above that fallback test (the one finding `/work laptop/i`), and add `removed_at: "2026-09-07T00:00:00.000Z"` and a `revoked_at` to its machine.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @onlooker/web test machines-page`
Expected: FAIL. There is no Delete button, and removed machines still show.

- [ ] **Step 3: Implement**

In `apps/web/src/pages/MachinesPage.tsx`:

1. Import `removeMachine` beside `revokeMachine`.

2. Rename the state so the status region can say either thing, and hold the whole sentence:
   - `revokedName` / `setRevokedName` becomes `status` / `setStatus`.
   - `pendingRevokedName` becomes `pendingStatus`.
   - `revokeError` / `setRevokeError` becomes `actionError` / `setActionError`.
   - The status `<p>` renders `{status}`. The revoke handler stores `` `Revoked ${machine.name}.` ``, and the flush effect's `setStatus(pending)` stays.
   - Update the comments that use the old names.

3. Add state beside `revoking`:

```tsx
	const [removing, setRemoving] = useState<string | null>(null);
```

4. Add after `revoke`:

```tsx
	const remove = async (machine: Machine) => {
		setRemoving(machine.id);
		setActionError(null);
		try {
			await removeMachine(machine.id);
			await load();
			// Parked under a reveal for the reason revoke parks its announcement.
			const message = `Deleted ${machine.name}.`;
			if (revealedRef.current) {
				pendingStatus.current = message;
			} else {
				setStatus(message);
			}
			// Unlike revoke, the row is gone, so the status region is the only
			// place left to stand.
			statusRef.current?.focus();
		} catch (error) {
			setActionError(describeError(error, "Could not delete that machine."));
		} finally {
			setRemoving(null);
		}
	};
```

5. Replace the comment and the early return in `action` with:

```tsx
		// A revoked machine keeps its row until its owner deletes it. Keyed, so
		// the confirm a revoke just armed cannot carry over into this one: same
		// slot, same component, and React would otherwise keep its state.
		if (machine.revoked_at) {
			return (
				<ConfirmAction
					key="delete"
					trigger="Delete"
					question={`Delete ${machine.name}? Its sessions stay.`}
					confirmLabel="Yes, delete"
					pendingLabel="Deleting..."
					variant="danger"
					pending={removing === machine.id}
					onConfirm={() => void remove(machine)}
				/>
			);
		}
```

Add `key="revoke"` to the existing `ConfirmAction`.

6. Filter once, after `orgName`, and render from the result:

```tsx
	// Only this page hides these. The Sessions page reads the same list to name
	// the machine an old session came from.
	const visible = machines?.filter((machine) => !machine.removed_at) ?? null;
```

In the JSX, use `visible` for the `=== null` check, the `.length === 0` check, the `.map`, and the `index === machines.length - 1` check.

7. Update the status `<p>`'s comment: focus also lands there after a delete.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/web test machines-page`, then `pnpm --filter @onlooker/web test sessions-page`.
Expected: PASS.

- [ ] **Step 5: Prove the key test by ablation**

With Edit, temporarily remove both `key` props, and run `pnpm --filter @onlooker/web test machines-page`.
Expected: `"does not carry an armed revoke confirm over to Delete"` FAILS. If it passes, the test proves nothing: report that rather than proceeding.

Restore them with Edit, and re-run. Expected: PASS. Record both outputs in the report.

- [ ] **Step 6: Run the full checks**

Run: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `bash scripts/source-guards.test.sh`.
Expected: all pass. Fix any formatting by hand with Edit.

- [ ] **Step 7: Commit**

Stage the three named files, with a message like:

```
feat(web): let a revoked machine be deleted from the page :broom:

Revoked rows piled up with nothing left to do to them. Deleting takes one
off this page only, so the Sessions page keeps naming its old sessions.

Refs ONL-231
```
