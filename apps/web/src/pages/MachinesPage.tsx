import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
	createMachine,
	listMachines,
	type Machine,
	type MintedMachine,
	revokeMachine,
} from "../api/machinesApi";
import { SubmitButton, TextField } from "../components/form";
import { PALETTE } from "../components/palette";
import TokenReveal from "../components/TokenReveal";
import { Button, Chip, EmptyState, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";

// Machine credentials, from the browser. POST /api/machines is browser-
// authenticated by design - a machine token cannot mint another, so revoking a
// stolen laptop actually revokes it - and until this page existed nothing in
// the browser called it, which meant nobody could turn the sync protocol on.

const cell = {
	borderBottom: `2px solid ${PALETTE.border}`,
	padding: "0.5rem",
	textAlign: "left" as const,
	verticalAlign: "top" as const,
};

/**
 * An instant, rendered so its value survives being read by a machine.
 * `toLocaleDateString` alone would make any assertion about it depend on the
 * runner's locale.
 */
function When({ iso }: { iso: string }) {
	return <time dateTime={iso}>{new Date(iso).toLocaleDateString()}</time>;
}

export default function MachinesPage() {
	const [machines, setMachines] = useState<Machine[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [minting, setMinting] = useState(false);
	const [mintError, setMintError] = useState<string | null>(null);
	const [revealed, setRevealed] = useState<MintedMachine | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
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
			setConfirming(null);
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
		// revoked it - but there is nothing left to do to it.
		if (machine.revoked_at) return null;

		if (confirming !== machine.id) {
			return (
				<Button
					variant="danger"
					onClick={() => {
						setRevokeError(null);
						setConfirming(machine.id);
					}}
				>
					Revoke
				</Button>
			);
		}

		return (
			<div
				style={{
					display: "flex",
					gap: "0.5rem",
					alignItems: "center",
					flexWrap: "wrap",
				}}
			>
				{/*
				  Inline rather than window.confirm. Revocation is the most
				  destructive act on this page, and the app should not hand it
				  to a native dialog that looks like nothing else in it.
				*/}
				<span>Revoke {machine.name}?</span>
				<Button
					variant="danger"
					loading={revoking === machine.id}
					loadingLabel="Revoking..."
					onClick={() => void revoke(machine.id)}
				>
					Yes, revoke
				</Button>
				<Button
					onClick={() => setConfirming(null)}
					disabled={revoking === machine.id}
				>
					Cancel
				</Button>
			</div>
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
						<table style={{ width: "100%", borderCollapse: "collapse" }}>
							<thead>
								<tr>
									<th scope="col" style={cell}>
										Name
									</th>
									<th scope="col" style={cell}>
										Created
									</th>
									<th scope="col" style={cell}>
										Last used
									</th>
									<th scope="col" style={cell}>
										<span
											style={{
												position: "absolute",
												width: 1,
												height: 1,
												overflow: "hidden",
												clip: "rect(0 0 0 0)",
											}}
										>
											Actions
										</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{machines.map((machine) => (
									<tr key={machine.id}>
										<th scope="row" style={cell}>
											<span style={{ marginRight: "0.5rem" }}>
												{machine.name}
											</span>
											{machine.revoked_at ? <Chip>Revoked</Chip> : null}
										</th>
										<td style={cell}>
											<When iso={machine.created_at} />
										</td>
										<td style={cell}>
											{machine.last_used_at ? (
												<When iso={machine.last_used_at} />
											) : (
												// Not a dash. Minting a token and never pointing
												// a plugin at it is the likeliest first-run
												// failure in the product, and a blank cell does
												// not say that - it reads as missing data.
												<Chip>Never used</Chip>
											)}
										</td>
										<td style={cell}>{action(machine)}</td>
									</tr>
								))}
							</tbody>
						</table>

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
