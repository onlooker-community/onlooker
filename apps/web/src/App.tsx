import { Route, Routes, useLocation } from "react-router-dom";
import { auth } from "./auth";
import ErrorBoundary from "./components/ErrorBoundary";
import DashboardPage from "./pages/DashboardPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import ProfilePage from "./pages/ProfilePage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import SettingsPage from "./pages/SettingsPage";
import SignupPage from "./pages/SignupPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";

export default function App() {
	const location = useLocation();

	// Inside the router, so the fallback's links work and a broken page does not
	// strand the session - BrowserRouter lives in main.tsx, above this.
	//
	// Keyed by pathname because a boundary that has caught stays caught. Without
	// the key the user would be held on the fallback for the rest of the session
	// no matter where they navigated, which is a worse failure than whatever
	// threw. Changing the path remounts it clean.
	return (
		<ErrorBoundary key={location.pathname}>
			<Routes>
				<Route path="/" element={<HomePage />} />
				<Route path="/login" element={<LoginPage />} />
				<Route path="/signup" element={<SignupPage />} />
				<Route path="/forgot-password" element={<ForgotPasswordPage />} />
				<Route path="/reset-password/:token" element={<ResetPasswordPage />} />
				<Route path="/verify-email/:token" element={<VerifyEmailPage />} />
				<Route
					path="/dashboard"
					element={
						<auth.RequireAuth>
							<DashboardPage />
						</auth.RequireAuth>
					}
				/>
				<Route
					path="/settings"
					element={
						<auth.RequireAuth>
							<SettingsPage />
						</auth.RequireAuth>
					}
				/>
				<Route
					path="/profile"
					element={
						<auth.RequireAuth>
							<ProfilePage />
						</auth.RequireAuth>
					}
				/>
				<Route path="*" element={<div>404 Not Found</div>} />
			</Routes>
		</ErrorBoundary>
	);
}
