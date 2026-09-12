import { useEffect } from "react";
import { auth } from "../auth";
import { monitor } from "../monitoring";

/**
 * Tells the monitor who is signed in, by id only. Renders nothing.
 *
 * A component rather than a call inside login, because a session also begins
 * by restoring a stored token, ends by expiring, and changes in another tab -
 * and all of those arrive here as `user` changing. The email is right there on
 * `user` and is deliberately left behind: the id finds the account from our
 * side and means nothing to anyone else.
 */
export default function MonitorIdentity() {
	const { user } = auth.useAuth();
	const id = user?.id;

	useEffect(() => {
		monitor.setUser(id ? { id } : null);
	}, [id]);

	return null;
}
