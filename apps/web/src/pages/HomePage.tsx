import { Link } from "react-router-dom";
import { auth } from "../auth";

export default function HomePage() {
	const authState = auth.useAuth();

	return (
		<div style={{ padding: "2rem" }}>
			<h1>Onlooker</h1>
			<p>Welcome to the Onlooker platform.</p>
			{authState.user ? (
				<>
					<p>Logged in as {authState.user.email}</p>
					<Link to="/lessons">Go to the pool</Link>
				</>
			) : (
				<Link to="/login">Log In</Link>
			)}
		</div>
	);
}
