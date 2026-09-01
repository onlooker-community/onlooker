import { Link } from "react-router-dom";
import { EmptyState, Panel } from "../components/ui";
import { useAuthenticatedFetch } from "../hooks/useAuthenticatedFetch";

interface ActivityEvent {
	seq: number;
	kind: string;
	at: string;
	lesson_id: string;
	claim: string;
	status: string;
}

interface ActivityResponse {
	events: ActivityEvent[];
	cursor: string | null;
	has_more: boolean;
}

/** The day an event belongs to, in the reader's own timezone. */
function dayKey(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
	});
}

function timeOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString(undefined, { timeStyle: "short" });
}

/**
 * What happened, in the order the feed recorded it.
 *
 * A `status` row says only that the status changed. lesson_feed has no from/to
 * columns, and naming the lesson's CURRENT status on a past event would be
 * wrong for anything that changed twice - a lesson retracted in March and
 * reinstated in April would show both events as "active". See the design spec.
 */
function describeKind(kind: string): string {
	if (kind === "create") return "Published";
	if (kind === "status") return "Status changed";
	return kind;
}

export default function ActivityPage() {
	const { data, loading, error } =
		useAuthenticatedFetch<ActivityResponse>("/api/activity");

	if (loading) return <p>Loading your activity…</p>;

	if (error) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Could not load your activity">{error}</EmptyState>
			</div>
		);
	}

	const events = data?.events ?? [];

	if (events.length === 0) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Nothing has happened yet">
					Lessons you publish and statuses you change will show up here, newest
					first.
				</EmptyState>
			</div>
		);
	}

	// Adjacency-only run-length encoding on dayKey: it only merges same-day
	// events that are NEXT to each other in `events`, so it depends on the API
	// returning events pre-sorted by seq DESC (see apps/api/src/db/lessons.ts,
	// listActivityPage's `ORDER BY f.seq DESC`). If that ordering ever changed
	// - a re-sort, a merge of multiple sources before this page sees them -
	// same-day events could land in two non-adjacent groups, producing a
	// duplicate `key={group.day}` on the Panel below.
	const days: { day: string; events: ActivityEvent[] }[] = [];
	for (const event of events) {
		const day = dayKey(event.at);
		const current = days[days.length - 1];
		if (current && current.day === day) current.events.push(event);
		else days.push({ day, events: [event] });
	}

	return (
		<div style={{ maxWidth: "640px", display: "grid", gap: "var(--space-4)" }}>
			{days.map((group) => (
				<Panel key={group.day} title={group.day} icon="Book">
					{group.events.map((event) => (
						<div
							key={event.seq}
							style={{
								display: "flex",
								gap: "var(--space-3)",
								padding: "0.35rem 0",
							}}
						>
							<span style={{ color: "var(--ink-dim)", flex: "none" }}>
								{timeOf(event.at)}
							</span>
							<span style={{ flex: "none" }}>{describeKind(event.kind)}</span>
							<Link to={`/lessons/${event.lesson_id}`}>{event.claim}</Link>
						</div>
					))}
				</Panel>
			))}
		</div>
	);
}
