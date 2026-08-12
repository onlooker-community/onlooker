import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { auth } from "./auth";
import "@onlooker/brand/tokens.css";
import "@onlooker/brand/assets.css";

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
