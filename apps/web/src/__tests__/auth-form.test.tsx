import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
	AuthCard,
	FormLink,
	FormMessage,
	SubmitButton,
	TextField,
} from "../components/form";

function renderInRouter(ui: React.ReactNode) {
	return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("AuthCard", () => {
	it("renders its title and children", () => {
		renderInRouter(
			<AuthCard title="Sign in">
				<p>form body</p>
			</AuthCard>,
		);
		expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
		expect(screen.getByText("form body")).toBeDefined();
	});

	// The card renders a <form> only when given onSubmit. Losing that would
	// break submit-on-enter without breaking anything visible.
	it("is a form when it has a submit handler", () => {
		const { container } = renderInRouter(
			<AuthCard title="Sign in" onSubmit={() => {}}>
				<p>body</p>
			</AuthCard>,
		);
		expect(container.querySelector("form")).not.toBeNull();
	});
});

describe("TextField", () => {
	it("associates its label with its input", () => {
		renderInRouter(
			<TextField id="email" label="Email" value="" onChange={() => {}} />,
		);
		// getByLabelText only resolves through a real htmlFor/id pairing.
		expect(screen.getByLabelText("Email")).toBeDefined();
	});

	it("exposes errors to assistive technology", () => {
		renderInRouter(
			<TextField
				id="email"
				label="Email"
				value=""
				onChange={() => {}}
				error="Email is required"
			/>,
		);
		const input = screen.getByLabelText("Email");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toContain("email-error");
		expect(screen.getByRole("alert").textContent).toBe("Email is required");
	});
});

describe("SubmitButton", () => {
	it("submits and shows its label", () => {
		renderInRouter(<SubmitButton>Sign in</SubmitButton>);
		const button = screen.getByRole("button", { name: "Sign in" });
		expect(button.getAttribute("type")).toBe("submit");
		expect((button as HTMLButtonElement).disabled).toBe(false);
	});

	it("disables and relabels while loading", () => {
		renderInRouter(
			<SubmitButton loading loadingLabel="Signing in...">
				Sign in
			</SubmitButton>,
		);
		const button = screen.getByRole("button", { name: "Signing in..." });
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("FormMessage", () => {
	it("announces errors as alerts", () => {
		renderInRouter(<FormMessage kind="error">Login failed</FormMessage>);
		expect(screen.getByRole("alert").textContent).toBe("Login failed");
	});

	it("announces success as status", () => {
		renderInRouter(<FormMessage kind="success">Check your email</FormMessage>);
		expect(screen.getByRole("status").textContent).toBe("Check your email");
	});
});

describe("FormLink", () => {
	it("renders a link to its target", () => {
		renderInRouter(<FormLink to="/signup">Create an account</FormLink>);
		const link = screen.getByRole("link", { name: "Create an account" });
		expect(link.getAttribute("href")).toBe("/signup");
	});
});
