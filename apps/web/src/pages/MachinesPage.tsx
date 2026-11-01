import type { IconName } from "@onlooker/brand";
import {
	type CSSProperties,
	type FormEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	createMachine,
	listMachines,
	type Machine,
	removeMachine,
	revokeMachine,
} from "../api/machinesApi";
import { listOrgs, type Org } from "../api/orgsApi";
import { ConfirmAction } from "../components/ConfirmAction";
import { SubmitButton, TextField } from "../components/form";
import { MachineInventory } from "../components/MachineInventory";
import { PALETTE } from "../components/palette";
import { Chip, EmptyState, Loading, Panel, Plate } from "../components/ui";
import { When } from "../components/When";
import { describeError } from "../lib/apiErrors";
import { useReveal } from "../reveal";

// Machine credentials, from the browser. POST /api/machines is browser-
// authenticated by design - a machine token cannot mint another, so revoking a
// stolen laptop actually revokes it - and until this page existed nothing in
// the browser called it, which meant nobody could turn the sync protocol on.

const row: CSSProperties = {
	display: "flex",
	gap: "var(--space-3)",
	alignItems: "center",
	padding: "var(--space-3)",
};

// A native select, matching the one LessonsPage's status filter and
// OrgsPage's role picker already use: one control on this form does not
// justify a SelectField in form.tsx, and the native control is what a
// screen reader and a keyboard already know how to drive.
const orgSelect: CSSProperties = {
	padding: "0.4rem 0.5rem",
	background: "var(--ground)",
	color: "var(--ink)",
	border: `2px solid ${PALETTE.border}`,
	borderRadius: 0,
	fontFamily: "var(--font-body)",
};

/**
 * Key for a live or revoked machine, Sleep for one that has never phoned
 * home. Revoked wins over never-used when both are true - a dead credential
 * is the more important fact to lead with than one that was merely idle.
 */
function machineIcon(machine: Machine): IconName {
	if (!machine.revoked_at && !machine.last_used_at) return "Sleep";
	return "Key";
}

export default function MachinesPage() {
	const [machines, setMachines] = useState<Machine[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [name, setName] = useState("");
	// "" is the narrower, private-only credential and the default - see the
	// picker's own option below. Also null, not an empty orgs array, while
	// this is still loading or failed to load: the private option must keep
	// working either way, so a failure here falls back to looking like an
	// account in no org rather than blocking the form.
	const [orgs, setOrgs] = useState<Org[] | null>(null);
	const [orgId, setOrgId] = useState("");
	const [minting, setMinting] = useState(false);
	const [mintError, setMintError] = useState<string | null>(null);
	const { revealed, reveal } = useReveal();
	const [revoking, setRevoking] = useState<string | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	// One machine open at a time. Enough for the page, and it keeps the
	// document fetch scoped to a component that unmounts when it closes -
	// see onlooker-bcn on not adding a fourth copy of a query lifecycle here.
	const [openInventory, setOpenInventory] = useState<string | null>(null);
	const [status, setStatus] = useState("");
	// Parked here rather than written straight to state when a reveal is open.
	// See the revoke handler and the flush effect below for why (onlooker-5o4).
	const pendingStatus = useRef<string | null>(null);
	// The current `revealed`, readable from inside an async handler that
	// captured a stale one. Maintained by the effect below.
	const revealedRef = useRef(revealed);
	const rowRefs = useRef(new Map<string, HTMLLIElement>());
	const statusRef = useRef<HTMLParagraphElement>(null);

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const { machines: rows } = await listMachines();
			setMachines(rows);
		} catch (error) {
			setMachines(null);
			setLoadError(describeError(error, "Could not load your machines."));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const loadOrgs = useCallback(async () => {
		try {
			const { orgs: rows } = await listOrgs();
			setOrgs(rows);
		} catch {
			// The picker is a convenience over the private-only default, and
			// that default has to keep working even when this call fails - so
			// a failed load leaves the account looking like it is in no org
			// rather than putting an error in front of the one path that must
			// still succeed.
			setOrgs([]);
		}
	}, []);

	useEffect(() => {
		void loadOrgs();
	}, [loadOrgs]);

	// Two jobs, one dependency.
	//
	// The mirror first. `revoke` captures `revealed` at the render that created
	// it, and the whole shape of onlooker-5o4 is a reveal that opens *during*
	// the await - so the captured value is stale precisely when it matters, and
	// reading it directly announces into an inert region every time. An effect
	// is also the correct boundary rather than merely the tidy one: if this has
	// not run, the dialog has not committed, nothing is inert yet, and an
	// immediate write is the right answer.
	//
	// Then the flush. It has to be a mutation performed while the region is
	// live. Parking the text into state early and letting the subtree merely
	// stop being inert would announce nothing: a node re-entering the
	// accessibility tree carrying content it already had is not a change, and
	// screen readers announce changes.
	//
	// Deliberately not carried across an unmount. If the person navigates away
	// while the reveal is up this page goes with it, and announcing "Revoked
	// work laptop." to someone now standing on /settings describes a screen
	// they have left.
	useEffect(() => {
		revealedRef.current = revealed;
		if (revealed) return;
		const pending = pendingStatus.current;
		if (pending === null) return;
		pendingStatus.current = null;
		setStatus(pending);
	}, [revealed]);

	const mint = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		// The modal traps focus and covers the form, so this should be
		// unreachable - but a second mint would silently replace a token
		// nobody has saved yet, and that loss can never be undone. One word
		// of defense-in-depth for a value that cannot be regenerated.
		if (!trimmed || minting || revealed) return;

		setMinting(true);
		setMintError(null);
		try {
			const created = await createMachine(trimmed, orgId || null);
			// The reveal goes up before the list is reloaded. If that reload
			// throws, the person still has their token on screen - losing the
			// only copy to a failed GET would be the one unrecoverable failure
			// this page is capable of.
			reveal(created);
			setName("");
			setOrgId("");
			await load();
		} catch (error) {
			setMintError(describeError(error, "Could not mint a token."));
			// The server write can have landed even though this caller never saw
			// the response - reload so a machine created but not shown is not
			// stranded, unrevokable, until a manual refresh finds it.
			void load();
		} finally {
			setMinting(false);
		}
	};

	const revoke = async (machine: Machine) => {
		setRevoking(machine.id);
		setActionError(null);
		try {
			await revokeMachine(machine.id);
			await load();
			// While a reveal is open this whole subtree is inert, and an inert
			// subtree is out of the accessibility tree - so this write would be
			// dropped with no sign at all. Park it for the effect above.
			//
			// role="status" is the politeness level that promises not to
			// interrupt, and the reveal is a credential shown exactly once and
			// unrecoverable if missed. Announcing over it would honor the letter
			// of the live region and violate its purpose, so this waits.
			//
			// The ref, not `revealed` - this closure was created before the
			// reveal opened and its captured copy is still null.
			const message = `Revoked ${machine.name}.`;
			if (revealedRef.current) {
				pendingStatus.current = message;
			} else {
				setStatus(message);
			}
			// The row element survives the refetch - revoked machines keep their
			// row - so this ref is still the same node the person was standing
			// on when the confirm button under their focus unmounted.
			//
			// Unless the refetch failed. `load` swaps the whole list for an error
			// state, so the row unmounted, its ref callback ran with null, and
			// this found nothing - dropping focus to <body>, which is the defect
			// the line above exists to prevent. The status region is the fallback:
			// always mounted, and it now reads "Revoked <name>." - the outcome of
			// what they just did. It sits at the top of the page rather than
			// beside the error, with the mint form in between, so Tab reaches
			// Retry after the form rather than immediately.
			//
			// Retry itself would be the better landing spot, but it is rendered by
			// EmptyState through a plain `action` prop, and Button is not a
			// forwardRef component under React 18 - reaching it would mean
			// threading a ref through two shared components for one caller.
			(rowRefs.current.get(machine.id) ?? statusRef.current)?.focus();
		} catch (error) {
			// Nothing was marked revoked ahead of the server, so there is
			// nothing to undo. A row that claimed a credential was dead while
			// it was still live is worse than a slow button. For the same
			// reason, a failed revoke does not move focus or announce
			// anything - the machine is still live.
			setActionError(describeError(error, "Could not revoke that machine."));
		} finally {
			setRevoking(null);
		}
	};

	const remove = async (machine: Machine) => {
		setRemoving(machine.id);
		setActionError(null);
		// Worked out before the row goes: the next visible row, or the previous
		// one when this was last. The row the person was standing on is about
		// to disappear, and landing on its neighbor keeps them in the list.
		const rows = visible ?? [];
		const at = rows.findIndex((row) => row.id === machine.id);
		const neighbor = rows[at + 1] ?? rows[at - 1];
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
			// The neighbor's row, falling back to the status region when there
			// is none (the last machine) or the reload failed and took every
			// row with it.
			const target = neighbor ? rowRefs.current.get(neighbor.id) : undefined;
			(target ?? statusRef.current)?.focus();
		} catch (error) {
			setActionError(describeError(error, "Could not delete that machine."));
			// The row may already be gone elsewhere (another tab, another
			// device); reload so it does not stay and answer "No such machine"
			// on every retry. `mint` does the same for the same reason.
			void load();
		} finally {
			setRemoving(null);
		}
	};

	// Resolved here rather than sent by the API: this page already lists the
	// account's orgs to build the picker above, and a name absent from that
	// list - the org fetch still loading, or the account having since left
	// it - renders nothing rather than a name this page cannot vouch for.
	const orgName = (machine: Machine): string | null =>
		machine.org_id
			? (orgs?.find((org) => org.id === machine.org_id)?.name ?? null)
			: null;

	// Only this page hides these. The Sessions page reads the same list to name
	// the machine an old session came from.
	const visible = machines?.filter((machine) => !machine.removed_at) ?? null;

	const action = (machine: Machine) => {
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

		return (
			<ConfirmAction
				key="revoke"
				trigger="Revoke"
				question={`Revoke ${machine.name}?`}
				confirmLabel="Yes, revoke"
				pendingLabel="Revoking..."
				variant="danger"
				pending={revoking === machine.id}
				onConfirm={() => void revoke(machine)}
			/>
		);
	};

	return (
		<>
			{/*
			  Always mounted, empty until it has something to say. A live region
			  that appears at the same moment as its text is the shape screen
			  readers skip.
			*/}
			<p
				ref={statusRef}
				role="status"
				// Focusable only by script, like the rows. This is where focus
				// goes when a delete leaves no row to land on, and when a revoke
				// or delete succeeds but the reload after it fails and takes the
				// rows with it.
				tabIndex={-1}
				style={{ margin: 0 }}
			>
				{status}
			</p>
			<Panel title="Mint a machine token">
				<p style={{ marginTop: 0 }}>
					A machine token is how a plugin pushes lessons to the pool. It is
					shown once, when it is created, and never again.
				</p>
				<form onSubmit={mint}>
					<TextField
						id="machine-name"
						label="Machine name"
						value={name}
						onChange={setName}
						disabled={minting}
						placeholder="work laptop"
						hint="Something you will recognize in this list later."
						error={mintError}
					/>
					<div style={{ marginBottom: "1rem" }}>
						<label
							htmlFor="machine-org"
							style={{ display: "block", marginBottom: "0.25rem" }}
						>
							Org
						</label>
						<select
							id="machine-org"
							value={orgId}
							disabled={minting}
							onChange={(event) => setOrgId(event.target.value)}
							style={orgSelect}
						>
							{/*
							  Value "" first and always present - a token that can
							  push to an org is the wider credential, so the
							  narrower, private-only default leads. An account in
							  no org sees only this option.
							*/}
							<option value="">Keep this token private</option>
							{(orgs ?? []).map((org) => (
								<option key={org.id} value={org.id}>
									{org.name}
								</option>
							))}
						</select>
					</div>
					<SubmitButton
						loading={minting}
						loadingLabel="Minting..."
						disabled={!name.trim()}
					>
						Mint token
					</SubmitButton>
				</form>
			</Panel>

			<div style={{ marginTop: "1.5rem" }}>
				{loadError ? (
					<EmptyState
						title="Could not load your machines"
						action={{ label: "Retry", onClick: () => void load() }}
					>
						{loadError}
					</EmptyState>
				) : visible === null ? (
					<Loading label="Loading machines…" />
				) : visible.length === 0 ? (
					<EmptyState title="No machines yet">
						Mint a token above, then paste it into a plugin&apos;s config to
						start syncing. If you lose a token, revoke its machine here and mint
						another — an existing one cannot be shown again.
					</EmptyState>
				) : (
					<Panel title="Your machines">
						{/*
						  Not a restored table: the visible Created/Last used labels
						  already recover what the column headers did, so only the row
						  boundaries and the item count were missing. ul/li restores
						  exactly that - and unlike a role attribute, a row can't lose
						  its listitem semantics just by having its markup refactored.
						  This wrapper holds rows and nothing else - the panel heading
						  lives on Panel's own <section>, one level up.
						*/}
						<ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
							{visible.map((machine, index) => {
								// Hoisted: the two reads below (the condition and the
								// child) would otherwise each walk `orgs` with their own
								// Array.find pass per row.
								const orgLabel = orgName(machine);
								return (
									<li
										key={machine.id}
										data-machine-row={machine.id}
										ref={(el) => {
											if (el) rowRefs.current.set(machine.id, el);
											else rowRefs.current.delete(machine.id);
										}}
										// Focusable only by script. The row is not a control, but
										// it is where a person was standing when the control under
										// their focus unmounted.
										tabIndex={-1}
										style={{
											...row,
											borderBottom:
												index === visible.length - 1
													? "none"
													: `2px solid ${PALETTE.border}`,
										}}
									>
										<Plate
											tone={machine.revoked_at ? "red" : "teal"}
											icon={machineIcon(machine)}
										/>
										<span style={{ minWidth: 0, flex: 1 }}>
											<span
												style={{
													display: "block",
													marginBottom: "var(--space-1)",
													fontSize: "var(--text-body-md)",
												}}
											>
												{machine.name}
											</span>
											<span
												style={{
													display: "flex",
													gap: "var(--space-2)",
													alignItems: "center",
													flexWrap: "wrap",
													color: PALETTE.muted,
													fontSize: "var(--text-body-sm)",
												}}
											>
												{machine.revoked_at ? <Chip>Revoked</Chip> : null}
												{orgLabel ? <Chip>{orgLabel}</Chip> : null}
												{/*
											  Labeled, not bare. LessonsPage's own meta line gets
											  away with an unlabeled date because it only ever
											  shows one - this row shows two, and the table it
											  replaced had "Created"/"Last used" column headers
											  doing the disambiguating work. Wrapped together so
											  the label and its date wrap as one unit rather than
											  splitting across lines at narrow widths.
											*/}
												<span
													style={{
														display: "inline-flex",
														gap: "var(--space-1)",
													}}
												>
													Created <When iso={machine.created_at} />
												</span>
												{machine.last_used_at ? (
													<span
														style={{
															display: "inline-flex",
															gap: "var(--space-1)",
														}}
													>
														Last used <When iso={machine.last_used_at} />
													</span>
												) : (
													// Not a dash. Minting a token and never pointing
													// a plugin at it is the likeliest first-run
													// failure in the product, and a blank line does
													// not say that - it reads as missing data.
													<Chip>Never used</Chip>
												)}
												{/*
											  Never reported is not zero plugins. One is a claim
											  about the machine, the other about what we know -
											  so the machine that has not told us gets a chip
											  rather than a count, and no control to expand.
											*/}
												{machine.inventory_at === null ? (
													<Chip>Never reported</Chip>
												) : (
													<button
														type="button"
														aria-expanded={openInventory === machine.id}
														onClick={() =>
															setOpenInventory(
																openInventory === machine.id
																	? null
																	: machine.id,
															)
														}
														style={{
															background: "none",
															border: "none",
															padding: 0,
															font: "inherit",
															color: "inherit",
															textDecoration: "underline",
															cursor: "pointer",
														}}
													>
														{machine.plugin_count}{" "}
														{machine.plugin_count === 1 ? "plugin" : "plugins"}
													</button>
												)}
											</span>
											{openInventory === machine.id ? (
												<MachineInventory machineId={machine.id} />
											) : null}
										</span>
										<span style={{ flex: "none" }}>{action(machine)}</span>
									</li>
								);
							})}
						</ul>

						{actionError ? (
							<p role="alert" style={{ color: PALETTE.danger }}>
								{actionError}
							</p>
						) : null}
					</Panel>
				)}
			</div>
		</>
	);
}
