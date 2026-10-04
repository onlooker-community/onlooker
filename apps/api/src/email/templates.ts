/**
 * The two messages this product sends.
 *
 * Both are plain and short on purpose. A password reset is read under mild
 * stress, often on a phone, and the only thing that matters is the link - so
 * the link appears as bare text as well as a button, because some clients strip
 * the markup and a reset mail that arrives with nothing clickable is a support
 * conversation.
 *
 * No shared layout, no images, no tracking pixel. Two messages do not need a
 * template system, and every remote asset is another reason for a spam filter
 * to hold the one email a locked-out user is waiting for.
 */

import type { EmailMessage } from "./index";

/** How long a reset link stays usable. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
/**
 * How long a verification link stays usable. Longer than a reset: nobody is
 * locked out while it sits unread, and it often arrives when someone is mid
 * signup and steps away.
 */
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function button(href: string, label: string): string {
	return (
		`<p><a href="${href}" ` +
		`style="display:inline-block;padding:12px 20px;` +
		`background:#221f38;color:#ffffff;text-decoration:none;` +
		`font-family:system-ui,sans-serif">${label}</a></p>` +
		// The bare URL, always. Clients that strip anchors leave the reader with
		// nothing otherwise, and this is the one line the message exists to carry.
		`<p style="font-family:system-ui,sans-serif;font-size:13px">` +
		`Or paste this into your browser:<br>${href}</p>`
	);
}

export function passwordResetEmail(to: string, link: string): EmailMessage {
	return {
		to,
		subject: "Reset your Onlooker password",
		text: [
			"Someone asked to reset the password for this Onlooker account.",
			"",
			`Reset it here: ${link}`,
			"",
			"The link works once and expires in an hour.",
			"If this wasn't you, ignore this email — nothing has changed, and",
			"your password still works.",
		].join("\n"),
		html: [
			`<p style="font-family:system-ui,sans-serif">Someone asked to reset the password for this Onlooker account.</p>`,
			button(link, "Reset password"),
			`<p style="font-family:system-ui,sans-serif;font-size:13px">The link works once and expires in an hour. If this wasn't you, ignore this email — nothing has changed, and your password still works.</p>`,
		].join("\n"),
	};
}

export function verifyEmailEmail(to: string, link: string): EmailMessage {
	return {
		to,
		subject: "Confirm your Onlooker email address",
		text: [
			"Confirm this address to finish setting up your Onlooker account.",
			"",
			`Confirm here: ${link}`,
			"",
			"The link works once and expires in a day.",
			"If you didn't sign up, ignore this email.",
		].join("\n"),
		html: [
			`<p style="font-family:system-ui,sans-serif">Confirm this address to finish setting up your Onlooker account.</p>`,
			button(link, "Confirm email address"),
			`<p style="font-family:system-ui,sans-serif;font-size:13px">The link works once and expires in a day. If you didn't sign up, ignore this email.</p>`,
		].join("\n"),
	};
}

/**
 * The invitation to join an org.
 *
 * `days` is a parameter, not a literal in the prose. The other templates here
 * can say "expires in a day" because their TTL is a constant on line 18 and
 * line 24 of this same file; this window is environment configuration, so a
 * hardcoded sentence would disagree with the enforced value the first time
 * anybody changed it.
 *
 * The link alone is not enough to join: accepting requires signing in as the
 * invited address. The copy says so, because somebody forwarding this to a
 * colleague should understand why it does not work for them.
 */
export function orgInviteEmail(
	to: string,
	orgName: string,
	inviterName: string,
	link: string,
	days: number,
): EmailMessage {
	const window = `${days} ${days === 1 ? "day" : "days"}`;
	const lead = `${inviterName} invited you to join ${orgName} on Onlooker.`;

	return {
		to,
		subject: `Join ${orgName} on Onlooker`,
		text: [
			lead,
			"",
			`Accept here: ${link}`,
			"",
			`The invitation expires in ${window}, and works only when you are signed in as ${to}.`,
			"If you weren't expecting this, ignore this email.",
		].join("\n"),
		html: [
			`<p style="font-family:system-ui,sans-serif">${lead}</p>`,
			button(link, `Join ${orgName}`),
			`<p style="font-family:system-ui,sans-serif;font-size:13px">The invitation expires in ${window}, and works only when you are signed in as ${to}. If you weren't expecting this, ignore this email.</p>`,
		].join("\n"),
	};
}
