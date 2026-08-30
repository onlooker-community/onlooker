import { Route, Routes, useLocation } from "react-router-dom";
import { auth } from "./auth";
import AppShell from "./components/AppShell";
import ErrorBoundary from "./components/ErrorBoundary";
import { reportClientError } from "./lib/reportError";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import HomePage from "./pages/HomePage";
import LessonDetail from "./pages/LessonDetail";
import LessonsPage from "./pages/LessonsPage";
import LoginPage from "./pages/LoginPage";
import MachinesPage from "./pages/MachinesPage";
import ProfilePage from "./pages/ProfilePage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import SettingsPage from "./pages/SettingsPage";
import SignupPage from "./pages/SignupPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";
import { RevealHost, RevealProvider } from "./reveal";

export default function App() {
	const location = useLocation();

	// Inside the router, so the fallback's links work and a broken page does not
	// strand the session - BrowserRouter lives in main.tsx, above this.
	//
	// resetKey, not key: a boundary that has caught stays caught, so it still
	// needs to clear on navigation - but a React `key` remounted every page on
	// every navigation, whether or not anything had thrown, which is what made
	// a lesson click refetch the whole pool instead of reading it from memory.
	// resetKey only resets state that is already set; see ErrorBoundary.
	return (
		<ErrorBoundary
			resetKey={location.pathname}
			// The prop existed and nothing passed it, so a render throw in
			// production left a trace in exactly one place: the console of the
			// person it broke for. That is where the blank dashboard went.
			onError={(error, info) =>
				reportClientError({
					kind: "render",
					message: error.message,
					stack: error.stack,
					componentStack: info.componentStack ?? undefined,
					url: window.location.href,
				})
			}
		>
			{/*
			  Above Routes, so neither a route change nor RequireAuth's
			  session-expiry redirect can unmount it and take the token with
			  it. It reads no auth state at all: session expiry nulls `user`
			  through the same path a logout does, so the two are
			  indistinguishable from here, and only one of them may end a
			  reveal. The Sign out buttons dismiss it themselves. See
			  reveal.tsx for the full story.
			*/}
			<RevealProvider>
				<Routes>
					<Route path="/" element={<HomePage />} />
					<Route path="/login" element={<LoginPage />} />
					<Route path="/signup" element={<SignupPage />} />
					<Route path="/forgot-password" element={<ForgotPasswordPage />} />
					<Route
						path="/reset-password/:token"
						element={<ResetPasswordPage />}
					/>
					<Route path="/verify-email/:token" element={<VerifyEmailPage />} />
					<Route
						path="/settings"
						element={
							<auth.RequireAuth>
								<AppShell>
									<SettingsPage />
								</AppShell>
							</auth.RequireAuth>
						}
					/>
					<Route
						path="/profile"
						element={
							<auth.RequireAuth>
								<AppShell>
									<ProfilePage />
								</AppShell>
							</auth.RequireAuth>
						}
					/>
					{/*
					  A layout route. LessonsPage fetches one page and renders the
					  list; the :id child renders its detail out of that same
					  in-memory list through the Outlet context, so clicking a row
					  issues no request. Deep links fall back to GET
					  /api/lessons/:id, which is the one case memory cannot answer.
					*/}
					<Route
						path="/lessons"
						element={
							<auth.RequireAuth>
								<AppShell>
									<LessonsPage />
								</AppShell>
							</auth.RequireAuth>
						}
					>
						<Route path=":id" element={<LessonDetail />} />
					</Route>
					<Route
						path="/machines"
						element={
							<auth.RequireAuth>
								<AppShell>
									<MachinesPage />
								</AppShell>
							</auth.RequireAuth>
						}
					/>
					<Route path="*" element={<div>404 Not Found</div>} />
				</Routes>
				<RevealHost />
			</RevealProvider>
		</ErrorBoundary>
	);
}
