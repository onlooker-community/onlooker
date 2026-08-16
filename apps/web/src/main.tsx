import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { auth } from "./auth";
import { installGlobalErrorReporting } from "./lib/reportError";
import "@onlooker/brand/tokens.css";
import "@onlooker/brand/assets.css";

// Before React mounts, so a failure during the first render is reported rather
// than lost. These catch what no boundary can see: rejected promises with no
// handler, throws from event listeners, and a dynamic import that 404s - which
// is what a stale tab hits after a deploy.
installGlobalErrorReporting();

document.documentElement.style.background = "var(--ground)";
document.documentElement.style.color = "var(--ink)";
document.documentElement.style.fontFamily = "var(--font-body)";

const rootElement = document.getElementById("root");
if (rootElement) {
	ReactDOM.createRoot(rootElement).render(
		<React.StrictMode>
			<BrowserRouter>
				<auth.AuthProvider>
					<App />
				</auth.AuthProvider>
			</BrowserRouter>
		</React.StrictMode>,
	);
}
