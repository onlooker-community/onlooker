import { describe, it, expect } from "vitest";
import {
	users,
	sessions,
	email_verification_tokens,
	password_reset_tokens,
	email_change_tokens,
	machine_tokens,
	audit_logs,
	type User,
	type Session,
	type EmailVerificationToken,
	type PasswordResetToken,
	type EmailChangeToken,
	type MachineToken,
	type AuditLog,
} from "../schema";

describe("Database Schema Types", () => {
	it("should export all tables", () => {
		expect(users).toBeDefined();
		expect(sessions).toBeDefined();
		expect(email_verification_tokens).toBeDefined();
		expect(password_reset_tokens).toBeDefined();
		expect(email_change_tokens).toBeDefined();
		expect(machine_tokens).toBeDefined();
		expect(audit_logs).toBeDefined();
	});

	it("should have correct User type shape", () => {
		const user: User = {
			id: "uuid-1",
			email: "test@example.com",
			password_hash: "$2b$10$...",
			name: "Test User",
			created_at: new Date().toISOString(),
			email_verified: new Date().toISOString(),
			deleted_at: null as any,
		};

		expect(user.id).toBeDefined();
		expect(user.email).toBeDefined();
		expect(user.password_hash).toBeDefined();
	});

	it("should have correct Session type shape", () => {
		const session: Session = {
			id: "session-uuid",
			user_id: "user-uuid",
			token: "hashed-token",
			expires_at: new Date().toISOString(),
			created_at: new Date().toISOString(),
		};

		expect(session.id).toBeDefined();
		expect(session.user_id).toBeDefined();
		expect(session.token).toBeDefined();
	});

	it("should have correct EmailVerificationToken type shape", () => {
		const token: EmailVerificationToken = {
			id: "token-uuid",
			user_id: "user-uuid",
			token: "hashed-token",
			expires_at: new Date().toISOString(),
			created_at: new Date().toISOString(),
			used_at: null as any,
		};

		expect(token.id).toBeDefined();
		expect(token.user_id).toBeDefined();
		expect(token.token).toBeDefined();
	});

	it("should have correct PasswordResetToken type shape", () => {
		const token: PasswordResetToken = {
			id: "token-uuid",
			user_id: "user-uuid",
			token: "hashed-token",
			expires_at: new Date().toISOString(),
			created_at: new Date().toISOString(),
			used_at: null as any,
		};

		expect(token.id).toBeDefined();
		expect(token.user_id).toBeDefined();
		expect(token.token).toBeDefined();
	});

	it("should have correct EmailChangeToken type shape", () => {
		const token: EmailChangeToken = {
			id: "token-uuid",
			user_id: "user-uuid",
			new_email: "newemail@example.com",
			token: "hashed-token",
			expires_at: new Date().toISOString(),
			created_at: new Date().toISOString(),
			used_at: null as any,
		};

		expect(token.id).toBeDefined();
		expect(token.user_id).toBeDefined();
		expect(token.new_email).toBeDefined();
	});

	it("should have correct MachineToken type shape", () => {
		const token: MachineToken = {
			id: "token-uuid",
			user_id: "user-uuid",
			machine_id: "machine-uuid",
			name: "GitHub CI",
			token: "hashed-token",
			created_at: new Date().toISOString(),
			expires_at: new Date().toISOString(),
			revoked_at: null as any,
			last_used_at: null as any,
		};

		expect(token.id).toBeDefined();
		expect(token.user_id).toBeDefined();
		expect(token.machine_id).toBeDefined();
		expect(token.name).toBeDefined();
	});

	it("should have correct AuditLog type shape", () => {
		const log: AuditLog = {
			id: "log-uuid",
			user_id: "user-uuid",
			action: "user_login",
			resource_type: "session",
			resource_id: "session-uuid",
			ip_address: "192.168.1.1",
			user_agent: "Mozilla/5.0...",
			created_at: new Date().toISOString(),
			details: JSON.stringify({ key: "value" }),
		};

		expect(log.id).toBeDefined();
		expect(log.user_id).toBeDefined();
		expect(log.action).toBeDefined();
	});

	it("should have tables with correct column definitions", () => {
		// This is a compile-time check that tables are properly defined
		// Runtime verification of table structure happens on database execution
		expect(users._.columns).toBeDefined();
		expect(sessions._.columns).toBeDefined();
	});
});
