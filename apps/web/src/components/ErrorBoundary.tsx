import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

interface Props {
	children: ReactNode;
	/** Called with anything caught. Wire this to reporting when there is any. */
	onError?: (error: Error, info: ErrorInfo) => void;
	/**
	 * Changing this clears a caught error. App passes the pathname, so
	 * navigating away recovers - see the class comment for why that has to
	 * happen without remounting `children`.
	 */
	resetKey?: string;
}

interface State {
	error: Error | null;
}

/**
 * Catches render errors so one broken page does not take the whole app with it.
 *
 * React's default for an uncaught error during render is to unmount the entire
 * tree, which produces an empty document: no message, no route change, nothing
 * saying anything happened. That is how a wrong response shape on /api/dashboard
 * turned into a blank screen, while the page's own "could not load" branch sat
 * unused a few lines away - it never ran, because the throw was during render
 * rather than in the fetch.
 *
 * A class is required here; hooks cannot catch render errors.
 *
 * Two placement details matter, and both are in App:
 *
 * 1. It sits INSIDE the router, so the fallback's links are live and a broken
 *    page does not strand the session.
 * 2. App passes `resetKey={location.pathname}`. A boundary that has caught
 *    stays caught, so without a reset the user would be stuck on this
 *    fallback for the rest of the session no matter where they navigated - a
 *    worse failure than the one being reported. This used to be done with a
 *    React `key` instead, which "worked" but remounted every page on every
 *    navigation, whether or not anything had thrown - which is what made a
 *    lesson click refetch the whole pool instead of reading it from memory.
 *    `resetKey` only clears state when there is an error to clear; it costs
 *    nothing on a navigation that never caught.
 */
export default class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// Without this a production render throw leaves no trace at all - it
		// looks exactly like a page that rendered nothing on purpose.
		console.error("Unhandled render error:", error, info.componentStack);
		this.props.onError?.(error, info);
	}

	componentDidUpdate(prevProps: Props) {
		// Guarded on state.error so a navigation that never caught does no
		// state work at all - the cost the old `key` paid on every navigation
		// regardless. When it HAS caught, React has already unmounted the
		// failed subtree; clearing the error here re-renders `children` fresh,
		// which is the same outcome the key produced by remounting wholesale.
		if (
			prevProps.resetKey !== this.props.resetKey &&
			this.state.error !== null
		) {
			this.setState({ error: null });
		}
	}

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;

		return (
			<div
				role="alert"
				style={{
					maxWidth: "420px",
					margin: "4rem auto",
					padding: "2rem",
					background: "var(--panel)",
					border: "2px solid var(--ink-dim)",
					boxShadow: "6px 6px 0 var(--shadow)",
				}}
			>
				<h1
					style={{
						marginTop: 0,
						marginBottom: "1rem",
						fontFamily: "var(--font-display)",
						color: "var(--ink-hi)",
						fontSize: "24px",
						letterSpacing: "0.5px",
					}}
				>
					Something went wrong
				</h1>

				<p style={{ marginTop: 0, color: "var(--ink)" }}>
					This page could not be displayed. The rest of the app still works.
				</p>

				{/* The message is the only clue a user can pass on in a report, so
				    it is shown rather than hidden behind a generic apology. */}
				<p
					style={{
						color: "var(--ink-dim)",
						fontFamily: "var(--font-body)",
						fontSize: "0.85rem",
						wordBreak: "break-word",
					}}
				>
					{error.message}
				</p>

				<div style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem" }}>
					<button
						type="button"
						onClick={() => window.location.reload()}
						style={{
							padding: "0.75rem 1.5rem",
							background: "var(--plate-teal)",
							color: "var(--plate-ink)",
							border: "2px solid var(--plate-ink)",
							boxShadow: "4px 4px 0 var(--shadow)",
							borderRadius: 0,
							cursor: "pointer",
							fontFamily: "var(--font-display)",
							fontSize: "14px",
							letterSpacing: "1px",
							textTransform: "uppercase",
						}}
					>
						Reload
					</button>

					<Link
						to="/"
						style={{
							padding: "0.75rem 1.5rem",
							color: "var(--ink)",
							border: "2px solid var(--ink-dim)",
							borderRadius: 0,
							textDecoration: "none",
							fontFamily: "var(--font-display)",
							fontSize: "14px",
							letterSpacing: "1px",
							textTransform: "uppercase",
						}}
					>
						Go home
					</Link>
				</div>
			</div>
		);
	}
}
