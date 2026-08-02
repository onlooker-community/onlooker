import { Route, Routes } from "react-router-dom";
import { auth } from "./auth";
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
	return (
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
	);
}
