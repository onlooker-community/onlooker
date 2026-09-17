import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { auth } from "./auth";
import AppShell from "./components/AppShell";
import ErrorBoundary from "./components/ErrorBoundary";
import { Loading } from "./components/ui";
import { monitor } from "./monitoring";
import ActivityPage from "./pages/ActivityPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import LessonDetail from "./pages/LessonDetail";
import LessonsPage from "./pages/LessonsPage";
import LoginPage from "./pages/LoginPage";
import MachinesPage from "./pages/MachinesPage";
import NotFoundPage from "./pages/NotFoundPage";
import ProfilePage from "./pages/ProfilePage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import SettingsPage from "./pages/SettingsPage";
import SignupPage from "./pages/SignupPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";
import { InertWhileRevealed, RevealHost, RevealProvider } from "./reveal";
import { useDocumentTitle } from "./titles";

/**
 * Every authenticated route: the guard, the chrome, and what to show while the
 * session is still resolving.
 *
 * The third of those is why this exists. RequireAuth's loadingFallback
 * defaults to null and nothing here ever passed one, so a hard refresh of any
 * shell route painted a blank page - no nav, no heading - until the session
 * came back. Composing it once means a sixth route gets the fallback by using
 * this wrapper rather than by someone remembering a prop.
 *
 * AppShell renders correctly with a null user; it already guards that case for
 * the header (`{user ? … : null}`), so the frame can be drawn before anyone is
 * known to be signed in.
 *
 * A signed-out person hitting a shell URL sees this frame briefly before
 * RequireAuth redirects them to /login. That is the accepted cost: the
 * alternative was a blank screen for everyone, including the signed-in case,
 * which is the common one.
 */
function Protected({ children }: { children: ReactNode }) {
	return (
		<auth.RequireAuth
			loadingFallback={
				<AppShell>
					<Loading label="Loading your session…" />
				</AppShell>
			}
		>
			<AppShell>{children}</AppShell>
		</auth.RequireAuth>
	);
}

/**
 * `/` is a decision, not a page.
 *
 * onlooker-yfw deleted the placeholder dashboard - handler, contract cases,
 * mock branch and page - and landed RequireAuth on /lessons. The landing route
 * moved then; HomePage stayed behind saying "Welcome to the Onlooker platform"
 * over a link to the pool.
 *
 * It waits for the session rather than guessing. Redirecting on an unresolved
 * one would send a signed-in person refreshing / to /login and then back,
 * which reads as having been logged out.
 *
 * AppShell's Sign out navigates here, so signing out resolves through this one
 * decision rather than through a second copy of it.
 */
function RootRedirect() {
	const { user, loading } = auth.useAuth();

	if (loading) return <Loading label="Loading your session…" />;

	return <Navigate to={user ? "/lessons" : "/login"} replace />;
}

export default function App() {
	const location = useLocation();

	// Once, here, rather than in each page - see titles.ts.
	useDocumentTitle();

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
				monitor.captureException(error, {
					tags: { kind: "render" },
					extra: { componentStack: info.componentStack ?? undefined },
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
				<InertWhileRevealed>
					<Routes>
						<Route path="/" element={<RootRedirect />} />
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
								<Protected>
									<SettingsPage />
								</Protected>
							}
						/>
						<Route
							path="/profile"
							element={
								<Protected>
									<ProfilePage />
								</Protected>
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
								<Protected>
									<LessonsPage />
								</Protected>
							}
						>
							<Route path=":id" element={<LessonDetail />} />
						</Route>
						<Route
							path="/machines"
							element={
								<Protected>
									<MachinesPage />
								</Protected>
							}
						/>
						<Route
							path="/activity"
							element={
								<Protected>
									<ActivityPage />
								</Protected>
							}
						/>
						<Route path="*" element={<NotFoundPage />} />
					</Routes>
				</InertWhileRevealed>
				{/*
				  Outside the wrapper above, and portaled to document.body
				  besides. Both are required: a dialog inside the inert subtree
				  would be disabled by the very attribute meant to protect it.
				*/}
				<RevealHost />
			</RevealProvider>
		</ErrorBoundary>
	);
}
