import { useEffect, useState } from "react";
import {
	getMachineInventory,
	type Inventory,
	type InventoryScope,
} from "../api/machinesApi";
import { describeError } from "../lib/apiErrors";
import { PALETTE } from "./palette";
import { Chip } from "./ui";
import { When } from "./When";

/**
 * What one machine reports it runs.
 *
 * Its own component, and its own fetch, because the list route deliberately
 * carries only a count: mounting this is what asks for the document, so a page
 * showing ten machines never pulls ten inventories to render ten summaries.
 */
export function MachineInventory({ machineId }: { machineId: string }) {
	const [inventory, setInventory] = useState<Inventory | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let current = true;
		setError(null);
		setInventory(null);

		getMachineInventory(machineId)
			.then((response) => {
				// Guarded because a machine can be collapsed and another
				// expanded before this resolves, and the late answer would
				// otherwise render under the wrong machine's name.
				if (current) setInventory(response.inventory);
			})
			.catch((cause) => {
				if (current) {
					setError(
						describeError(cause, "Could not load this machine's inventory."),
					);
				}
			});

		return () => {
			current = false;
		};
	}, [machineId]);

	if (error) {
		return (
			<p role="alert" style={{ color: PALETTE.danger }}>
				{error}
			</p>
		);
	}

	if (!inventory) return <p>Loading what this machine runs…</p>;

	return (
		<div style={{ display: "grid", gap: "var(--space-2)" }}>
			<p style={{ fontSize: "var(--text-body-sm)" }}>
				Collected <When iso={inventory.collected_at} />
				{inventory.project === null ? null : ` from ${inventory.project}`}
			</p>

			{inventory.plugins.length === 0 ? (
				// A real report that names nothing, which is different from the
				// machine never having reported - the row above says which.
				<p>This machine reported no plugins installed.</p>
			) : (
				<ul style={{ display: "grid", gap: "var(--space-2)" }}>
					{inventory.plugins.map((plugin) => (
						<li key={plugin.id}>
							<h4 style={{ fontSize: "var(--text-body-sm)" }}>{plugin.id}</h4>
							<ul style={{ display: "grid", gap: "var(--space-1)" }}>
								{plugin.scopes.map((scope) => (
									<li
										key={`${plugin.id}:${scope.scope}`}
										style={{
											display: "flex",
											flexWrap: "wrap",
											gap: "var(--space-2)",
											alignItems: "center",
											fontSize: "var(--text-body-sm)",
										}}
									>
										<code>{scope.version}</code>
										<span>{scope.scope}</span>
										{scope.git_commit_sha ? (
											<code title={scope.git_commit_sha}>
												{scope.git_commit_sha.slice(0, 7)}
											</code>
										) : null}
										<EnablementChip enabled={scope.enabled} />
									</li>
								))}
							</ul>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * Says something only when there is something to say.
 *
 * `false` means settings were read and this plugin is switched off - installed
 * but inert, which is the distinction #97 was filed over, and worth a word.
 *
 * `null` gets no chip at all. The reporting machine could not know: a project's
 * enabled set lives in that project's own `.claude`, and sync opens exactly one
 * of them - so on a machine with 28 plugins, every project scope but the one
 * that synced is unknowable by construction. Labelling each of those "unknown"
 * made most of the page a repeated announcement that it had no information.
 * The row still carries the version, the scope and the sha; only the claim is
 * withheld, which is what absence already means.
 *
 * The distinction stays in the data either way. `enabled: null` is still
 * reported, stored and served - this decides only what the page asserts.
 */
function EnablementChip({ enabled }: { enabled: InventoryScope["enabled"] }) {
	if (enabled === null) return null;
	return <Chip>{enabled ? "enabled" : "inert"}</Chip>;
}
