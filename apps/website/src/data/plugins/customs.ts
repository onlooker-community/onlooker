import type { PluginProse } from "./types";

export const customs: PluginProse = {
	slug: "customs",
	name: "Customs",
	tagline: "Checks where a secret is headed before it leaves.",
	category: "safety",
	problem:
		"A coding agent runs shell commands and fetches URLs, and a command can carry a token with it. A GitHub token sent to api.github.com is ordinary work. The same token sent to a paste site is a leak, and nothing in the command looks different except the host. Warden guards what comes in; Customs guards what goes out.",
	howItWorks: [
		"On PreToolUse for Bash and WebFetch, Customs scans the call for secret-shaped literals. A Bash command with no network tool, or a call with no secret, passes silently.",
		"It reads the destination hosts from the URLs and network-tool arguments in the call, and treats any host it cannot read as unknown.",
		"A kind of secret is trusted only at its own hosts: a GitHub token passes to api.github.com, and the same token to anywhere else asks.",
		'A miss returns ask, or deny under mode: "deny". The reason names the kind of secret and the host, never the value. Customs is opt-in and does nothing until you enable it.',
	],
};
