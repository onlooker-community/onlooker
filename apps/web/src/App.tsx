// Phase 1: Integration test - verify auth-react exports are accessible
import { AuthProvider } from "@onlooker/auth-react";

export default function App() {
	return (
		<AuthProvider>
			<div>
				<h1>Onlooker Web App</h1>
				<p>Scaffold ready for feature development.</p>
			</div>
		</AuthProvider>
	);
}
