-- Create users table
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	name TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	email_verified TEXT,
	deleted_at TEXT
);

-- Create unique index for email lookups
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at);
CREATE INDEX IF NOT EXISTS users_deleted_at_idx ON users(deleted_at);

-- Create sessions table for refresh tokens
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	token TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_created_at_idx ON sessions(created_at);

-- Create email_verification_tokens table
CREATE TABLE IF NOT EXISTS email_verification_tokens (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	token TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	used_at TEXT,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_user_id_idx ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS email_verification_tokens_expires_at_idx ON email_verification_tokens(expires_at);
CREATE INDEX IF NOT EXISTS email_verification_tokens_used_at_idx ON email_verification_tokens(used_at);

-- Create password_reset_tokens table
CREATE TABLE IF NOT EXISTS password_reset_tokens (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	token TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	used_at TEXT,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_at_idx ON password_reset_tokens(expires_at);
CREATE INDEX IF NOT EXISTS password_reset_tokens_used_at_idx ON password_reset_tokens(used_at);

-- Create email_change_tokens table
CREATE TABLE IF NOT EXISTS email_change_tokens (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	new_email TEXT NOT NULL,
	token TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	used_at TEXT,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS email_change_tokens_user_id_idx ON email_change_tokens(user_id);
CREATE INDEX IF NOT EXISTS email_change_tokens_new_email_idx ON email_change_tokens(new_email);
CREATE INDEX IF NOT EXISTS email_change_tokens_expires_at_idx ON email_change_tokens(expires_at);
CREATE INDEX IF NOT EXISTS email_change_tokens_used_at_idx ON email_change_tokens(used_at);

-- Create machine_tokens table for API keys
CREATE TABLE IF NOT EXISTS machine_tokens (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	machine_id TEXT NOT NULL,
	name TEXT NOT NULL,
	token TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at TEXT,
	revoked_at TEXT,
	last_used_at TEXT,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS machine_tokens_user_id_idx ON machine_tokens(user_id);
CREATE INDEX IF NOT EXISTS machine_tokens_machine_id_idx ON machine_tokens(machine_id);
CREATE INDEX IF NOT EXISTS machine_tokens_revoked_at_idx ON machine_tokens(revoked_at);

-- Create audit_logs table for compliance and debugging
CREATE TABLE IF NOT EXISTS audit_logs (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	action TEXT NOT NULL,
	resource_type TEXT,
	resource_id TEXT,
	ip_address TEXT,
	user_agent TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	details TEXT,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at);
