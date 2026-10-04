import { describe, expect, it } from "vitest";
import { orgInviteEmail } from "./templates.js";

describe("orgInviteEmail", () => {
	it("states the window it was given, in both bodies", () => {
		// The window is configuration, so the prose cannot restate it as a
		// literal. verifyEmailEmail says "expires in a day" because its TTL is a
		// constant beside it; this one's is not, and a template that disagreed
		// with the enforced value would be an email that lies.
		const message = orgInviteEmail(
			"invitee@example.com",
			"Acme",
			"Ada",
			"https://app.onlooker.dev/orgs/invites/abc",
			3,
		);
		expect(message.text).toContain("3 days");
		expect(message.html).toContain("3 days");
	});

	it("says one day without pluralizing", () => {
		const message = orgInviteEmail(
			"invitee@example.com",
			"Acme",
			"Ada",
			"https://app.onlooker.dev/orgs/invites/abc",
			1,
		);
		expect(message.text).toContain("1 day");
		expect(message.text).not.toContain("1 days");
	});

	it("names the org and the inviter", () => {
		const message = orgInviteEmail(
			"invitee@example.com",
			"Acme",
			"Ada",
			"https://app.onlooker.dev/orgs/invites/abc",
			7,
		);
		expect(message.text).toContain("Acme");
		expect(message.text).toContain("Ada");
		expect(message.subject).toContain("Acme");
	});
});
