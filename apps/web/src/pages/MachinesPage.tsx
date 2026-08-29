import type { IconName } from "@onlooker/brand";
import {
	type CSSProperties,
	type FormEvent,
	useCallback,
	useEffect,
	useState,
} from "react";
import {
	createMachine,
	listMachines,
	type Machine,
	type MintedMachine,
	revokeMachine,
} from "../api/machinesApi";
import { ConfirmAction } from "../components/ConfirmAction";
import { SubmitButton, TextField } from "../components/form";
import { PALETTE } from "../components/palette";
import TokenReveal from "../components/TokenReveal";
import { Chip, EmptyState, Panel, Plate } from "../components/ui";
import { When } from "../components/When";
import { describeError } from "../lib/apiErrors";

// Machine credentials, from the browser. POST /api/machines is browser-
// authenticated by design - a machine token cannot mint another, so revoking a
// stolen laptop actually revokes it - and until this page existed nothing in
// the browser called it, which meant nobody could turn the sync protocol on.

const row: CSSProperties = {
	display: "flex",
	gap: "var(--space-3)",
	alignItems: "center",
	padding: "var(--space-3)",
	borderBottom: `2px solid ${PALETTE.border}`,
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
	const [minting, setMinting] = useState(false);
	const [mintError, setMintError] = useState<string | null>(null);
	const [revealed, setRevealed] = useState<MintedMachine | null>(null);
	const [revoking, setRevoking] = useState<string | null>(null);
	const [revokeError, setRevokeError] = useState<string | null>(null);

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
			const created = await createMachine(trimmed);
			// The reveal goes up before the list is reloaded. If that reload
			// throws, the person still has their token on screen - losing the
			// only copy to a failed GET would be the one unrecoverable failure
			// this page is capable of.
			setRevealed(created);
			setName("");
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

	const revoke = async (id: string) => {
		setRevoking(id);
		setRevokeError(null);
		try {
			await revokeMachine(id);
			await load();
		} catch (error) {
			// Nothing was marked revoked ahead of the server, so there is
			// nothing to undo. A row that claimed a credential was dead while
			// it was still live is worse than a slow button.
			setRevokeError(describeError(error, "Could not revoke that machine."));
		} finally {
			setRevoking(null);
		}
	};

	const action = (machine: Machine) => {
		// A revoked machine keeps its row - that is how a person sees that they
		// revoked it - but there is nothing left to do to it. The row losing its
		// ConfirmAction here is also what disarms a confirm after a successful
		// revoke: there is no row left to hold the armed state.
		if (machine.revoked_at) return null;

		return (
			<ConfirmAction
				trigger="Revoke"
				question={`Revoke ${machine.name}?`}
				confirmLabel="Yes, revoke"
				pendingLabel="Revoking..."
				variant="danger"
				pending={revoking === machine.id}
				onConfirm={() => void revoke(machine.id)}
			/>
		);
	};

	return (
		<>
			{revealed ? (
				<TokenReveal machine={revealed} onDismiss={() => setRevealed(null)} />
			) : null}

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
				) : machines === null ? (
					<p style={{ color: PALETTE.muted }}>Loading machines...</p>
				) : machines.length === 0 ? (
					<EmptyState title="No machines yet">
						Mint a token above, then paste it into a plugin&apos;s config to
						start syncing. If you lose a token, revoke its machine here and mint
						another — an existing one cannot be shown again.
					</EmptyState>
				) : (
					<Panel title="Your machines">
						{machines.map((machine) => (
							<div key={machine.id} style={row}>
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
											style={{ display: "inline-flex", gap: "var(--space-1)" }}
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
									</span>
								</span>
								<span style={{ flex: "none" }}>{action(machine)}</span>
							</div>
						))}

						{revokeError ? (
							<p role="alert" style={{ color: PALETTE.danger }}>
								{revokeError}
							</p>
						) : null}
					</Panel>
				)}
			</div>
		</>
	);
}
