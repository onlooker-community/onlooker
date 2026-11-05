import { Link } from "react-router-dom";
import { auth } from "../auth";
import AppShell from "../components/AppShell";
import { PALETTE } from "../components/palette";
import { EmptyState, Loading } from "../components/ui";

/**
 * The catch-all, in three states because it has three audiences.
 *
 * Deliberately NOT behind RequireAuth. Someone who mistypes a URL should be
 * told the page does not exist; asking them to log in first answers a question
 * they did not ask and hides the one they did.
 *
 * The loading state is bare rather than wrapped in AppShell - the opposite of
 * Protected. Protected is entered by someone already heading into the app, so
 * drawing the frame early is the fix. Here the visitor may not be signed in at
 * all, and showing them the whole app chrome for a moment would be its own
 * flash. What both share is that neither says "not found" before it knows.
 */
export default function NotFoundPage() {
	const { user, loading, unavailable } = auth.useAuth();

	if (loading) return <Loading label="Loading your session…" />;

	// Unreachable is not signed out, so it is not offered a sign-in (ONL-247).
	// `/` decides once the session answers.
	const link = user
		? { to: "/lessons", label: "Back to the pool" }
		: unavailable
			? { to: "/", label: "Continue to Onlooker" }
			: { to: "/login", label: "Sign in" };

	const body = (
		<EmptyState headingLevel={1} title="Page not found" icon="Eye">
			That address does not match anything here.{" "}
			<Link to={link.to} style={{ color: PALETTE.accent }}>
				{link.label}
			</Link>
		</EmptyState>
	);

	return user ? <AppShell>{body}</AppShell> : body;
}
