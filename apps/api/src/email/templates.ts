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
