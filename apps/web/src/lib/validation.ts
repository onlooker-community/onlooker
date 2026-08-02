// Shared client-side validation for auth forms.
// Server remains the source of truth; these rules give fast, friendly feedback.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

// Kept short and illustrative — the server enforces the authoritative list.
const COMMON_PASSWORDS = new Set([
	"password",
	"password1",
	"password123",
	"12345678",
	"123456789",
	"qwerty123",
	"letmein",
	"iloveyou",
	"admin123",
	"welcome1",
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
	return EMAIL_PATTERN.test(email.trim());
}

export function validateEmail(email: string): string | null {
	if (!email.trim()) return "Email is required.";
	if (!isValidEmail(email)) return "Enter a valid email address.";
	return null;
}

export type PasswordStrength = {
	// 0 (empty) .. 4 (strong)
	score: 0 | 1 | 2 | 3 | 4;
	label: "Empty" | "Very weak" | "Weak" | "Fair" | "Good" | "Strong";
	// Human-readable suggestions for reaching the next level.
	suggestions: string[];
	// True once the password satisfies the minimum acceptance rules.
	meetsRequirements: boolean;
};

export type PasswordChecks = {
	minLength: boolean;
	hasLower: boolean;
	hasUpper: boolean;
	hasNumber: boolean;
	hasSymbol: boolean;
	notCommon: boolean;
};

export function getPasswordChecks(password: string): PasswordChecks {
	return {
		minLength: password.length >= MIN_PASSWORD_LENGTH,
		hasLower: /[a-z]/.test(password),
		hasUpper: /[A-Z]/.test(password),
		hasNumber: /[0-9]/.test(password),
		hasSymbol: /[^A-Za-z0-9]/.test(password),
		notCommon: !COMMON_PASSWORDS.has(password.toLowerCase()),
	};
}

export function scorePassword(password: string): PasswordStrength {
	if (!password) {
		return {
			score: 0,
			label: "Empty",
			suggestions: [`Use at least ${MIN_PASSWORD_LENGTH} characters.`],
			meetsRequirements: false,
		};
	}

	const checks = getPasswordChecks(password);
	const suggestions: string[] = [];

	if (!checks.minLength) {
		suggestions.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
	}
	if (!checks.hasLower || !checks.hasUpper) {
		suggestions.push("Mix uppercase and lowercase letters.");
	}
	if (!checks.hasNumber) suggestions.push("Add a number.");
	if (!checks.hasSymbol) suggestions.push("Add a symbol (e.g. !?@#).");
	if (!checks.notCommon) {
		suggestions.push("Avoid common passwords that are easy to guess.");
	}

	// A password that fails the minimum rules can never rank above "Weak".
	const meetsRequirements =
		checks.minLength && checks.notCommon && countTrue(checks) >= 4;

	let raw = 0;
	if (checks.minLength) raw += 1;
	if (checks.hasLower && checks.hasUpper) raw += 1;
	if (checks.hasNumber) raw += 1;
	if (checks.hasSymbol) raw += 1;
	if (password.length >= 12) raw += 1;
	if (!checks.notCommon || !checks.minLength) raw = Math.min(raw, 1);

	const score = Math.min(4, raw) as PasswordStrength["score"];
	const label = (
		["Very weak", "Very weak", "Weak", "Fair", "Good", "Strong"] as const
	)[Math.min(raw, 5)] as PasswordStrength["label"];

	return { score, label, suggestions, meetsRequirements };
}

function countTrue(checks: PasswordChecks): number {
	return Object.values(checks).filter(Boolean).length;
}

export function validatePassword(password: string): string | null {
	if (!password) return "Password is required.";
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	if (password.length > MAX_PASSWORD_LENGTH) {
		return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
	}
	if (COMMON_PASSWORDS.has(password.toLowerCase())) {
		return "This password is too common. Choose something harder to guess.";
	}
	return null;
}

export function validatePasswordMatch(
	password: string,
	confirmation: string,
): string | null {
	if (!confirmation) return "Please confirm your password.";
	if (password !== confirmation) return "Passwords do not match.";
	return null;
}
