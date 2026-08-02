import { Route, Routes } from "react-router-dom";
import { auth } from "./auth";
import DashboardPage from "./pages/DashboardPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";

export default function App() {
	return (
		<Routes>
			<Route path="/" element={<HomePage />} />
			<Route path="/login" element={<LoginPage />} />
			<Route
				path="/dashboard"
				element={
					<auth.RequireAuth>
						<DashboardPage />
					</auth.RequireAuth>
				}
			/>
			<Route path="*" element={<div>404 Not Found</div>} />
		</Routes>
	);
}
