/**
 * Sending mail, behind one function.
 *
 * Resend was chosen over Cloudflare Email Service, Postmark and SendGrid
 * (onlooker-bde.2): free at this volume, GA rather than beta, and a plain fetch
 * from a Worker with no SDK. That choice is expected to change - Cloudflare's
 * native binding is the likelier long-term answer once it leaves beta - which is
 * why every caller depends on `sendEmail` and nothing else knows the vendor.
 *
 * The five account endpoints that need mail therefore depend on AN email
 * function, not on Resend. Swapping providers is this file.
 */

import { redactSecrets } from "@onlooker/api-contract";
import type { WorkerEnv } from "../types";

export interface EmailMessage {
	to: string;
	subject: string;
	/** Plain text. Always sent, and the only part some clients will show. */
	text: string;
	html: string;
}

/**
 * Send one message, or report why it could not be sent.
 *
 * Returns a result rather than throwing, because every caller has to decide
 * what a delivery failure means for its own response and most of them must not
 * surface it. forgot-password in particular answers identically whether or not
 * the address exists, so it cannot turn a send failure into a different status
 * without leaking exactly what that uniformity protects.
 */
export type SendResult = { sent: true } | { sent: false; reason: string };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * How much of a recipient belongs in a log line.
 *
 * Only development gets the address, and only because there the log IS the
 * inbox: with no key configured, a flow whose link goes nowhere cannot be
 * walked. Everywhere else the domain is the whole diagnostic value - an
 * unverified sending domain and a recipient domain rejecting everything are the
 * two failures these lines exist to tell apart - while the local part is a
 * person's name, written into a log store whose audience is not the one they
 * gave their address to.
 *
 * Anything other than the literal "development" redacts. ENVIRONMENT is
 * optional on WorkerEnv, so the branch has to fail toward redaction: the
 * environment nobody configured must not be the one that leaks.
 */
function loggableAddress(env: WorkerEnv, to: string): string {
	if (env.ENVIRONMENT === "development") return to;

	const at = to.lastIndexOf("@");
	return at === -1 ? "[redacted]" : `[redacted]@${to.slice(at + 1)}`;
}

export async function sendEmail(
	env: WorkerEnv,
	message: EmailMessage,
): Promise<SendResult> {
	// No key configured is the normal state in local development, where there is
	// no reason to hand a real provider real addresses. Logging the message lets
	// the whole flow be exercised end to end - the link is right there in the
	// worker output - which is what apps/web's mock already does.
	//
	// In a deployed environment this is a misconfiguration, and the log line is
	// how it gets found. It is deliberately not an exception: a missing key must
	// not turn "we emailed you a link" into a 500 that tells an attacker which
	// addresses are registered.
	//
	// The body is appended only in development, and that condition is the whole
	// point of the split. `message.text` carries a live single-use reset or
	// verify link, so writing it to Workers Logs hands anyone with log access a
	// credential that was addressed to somebody else - a longer-lived and more
	// widely readable copy than the inbox it was meant for. Locally there is no
	// inbox and no real address, so nothing is at stake and the link is what
	// makes the flow walkable. onlooker-9dqr.
	if (!env.RESEND_API_KEY) {
		const body =
			env.ENVIRONMENT === "development"
				? `\n${message.text}`
				: " (body omitted)";

		console.warn(
			`[email] RESEND_API_KEY is not set; not sending. ` +
				`to=${loggableAddress(env, message.to)} ` +
				`subject=${JSON.stringify(message.subject)}${body}`,
		);
		return { sent: false, reason: "no_api_key" };
	}

	try {
		const response = await fetch(RESEND_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				from: env.EMAIL_FROM,
				to: [message.to],
				subject: message.subject,
				text: message.text,
				html: message.html,
			}),
		});

		if (!response.ok) {
			// Body, not just status. Resend's failures are mostly configuration -
			// an unverified domain, a from address that does not belong to it - and
			// the status alone cannot tell those apart.
			//
			// Redacted because the provider, not this code, decides what that body
			// says. A validation error that quotes the request back would put the
			// link in the log through a door nothing here opened.
			const detail = redactSecrets(await response.text());
			console.error(
				`[email] send failed: ${response.status} ${detail} ` +
					`to=${loggableAddress(env, message.to)}`,
			);
			return { sent: false, reason: `http_${response.status}` };
		}

		return { sent: true };
	} catch (cause) {
		// A network failure to the provider must not take the request down with
		// it. The caller decides what to tell the user.
		console.error(
			`[email] send threw: ${redactSecrets(String(cause))} ` +
				`to=${loggableAddress(env, message.to)}`,
		);
		return { sent: false, reason: "network_error" };
	}
}
