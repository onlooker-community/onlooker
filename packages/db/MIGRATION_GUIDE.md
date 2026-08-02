# Migration Guide

This guide walks through running database migrations locally and in production.

## Table of Contents

1. [Local Development Setup](#local-development-setup)
2. [Running Migrations Locally](#running-migrations-locally)
3. [Production Migrations](#production-migrations)
4. [Future Migration Workflow](#future-migration-workflow)
5. [Troubleshooting](#troubleshooting)

## Local Development Setup

### Prerequisites

- Node.js >= 20.19.0
- pnpm 11.0.9+
- Wrangler CLI

### Step 1: Install Wrangler

```bash
# Using mise (recommended)
mise use wrangler@latest

# Or install globally
npm install -g wrangler
```

Verify installation:
```bash
wrangler --version
```

### Step 2: Create Local D1 Database

Navigate to the monorepo root and create a local D1 database:

```bash
cd /path/to/onlooker

# Create local D1 database named 'onlooker'
wrangler d1 create onlooker --local
```

This creates a SQLite database file at `.wrangler/state/d1/db.sqlite`.

### Step 3: Set Up wrangler.toml

In the monorepo root, create or update `wrangler.toml`:

```toml
name = "onlooker"
type = "service"
compatibility_date = "2024-11-21"
compatibility_flags = ["nodejs_compat"]

# D1 Database Binding
[[d1_databases]]
binding = "DB"
database_name = "onlooker"
database_id = "00000000-0000-0000-0000-000000000000"

[env.production]
# Production database ID (set after deploying to Cloudflare)
d1_databases = [
  { binding = "DB", database_name = "onlooker", database_id = "YOUR_PROD_DB_ID" }
]
```

### Step 4: Verify Database Creation

```bash
# List local databases
wrangler d1 list --local

# Should output:
# ┌──────────────────────────────────────────────────────────────┐
# │ D1 Databases                                                 │
# ├──────────────────────────────────────────────────────────────┤
# │ Name      | Database ID                      | Created        │
# ├───────────┼──────────────────────────────────┼────────────────┤
# │ onlooker  | 00000000-0000-0000-0000-00000000 | Nov 21, 2024   │
# └──────────────────────────────────────────────────────────────┘
```

## Running Migrations Locally

### Initial Migration (Schema Creation)

The first migration creates all tables. Run it from the monorepo root:

```bash
# From monorepo root
wrangler d1 execute onlooker --local < packages/db/migrations/0001_create_auth_tables.sql
```

### Verify Migration Success

Check that tables were created:

```bash
# List tables
wrangler d1 execute onlooker --local --command ".tables"

# Output should be:
# audit_logs  email_change_tokens  email_verification_tokens  machine_tokens  password_reset_tokens  sessions  users
```

Check table schema:

```bash
# View users table schema
wrangler d1 execute onlooker --local --command ".schema users"

# Output should include:
# CREATE TABLE users (
#   id TEXT PRIMARY KEY,
#   email TEXT NOT NULL UNIQUE,
#   password_hash TEXT NOT NULL,
#   ...
# )
```

### Running Subsequent Migrations

After creating new migrations, apply them:

```bash
# Execute a migration file
wrangler d1 execute onlooker --local < packages/db/migrations/0002_your_migration.sql
```

### SQL REPL (Interactive)

For interactive database exploration and testing:

```bash
# Open interactive SQL shell
wrangler d1 execute onlooker --local --interactive

# Now you can run SQL commands:
sqlite> SELECT COUNT(*) FROM users;
sqlite> INSERT INTO users (id, email, password_hash) VALUES ('uuid-1', 'test@example.com', 'hash');
sqlite> SELECT * FROM users;
sqlite> .quit
```

## Production Migrations

### Before First Deployment

1. **Create Production D1 Database**

```bash
# Create database in your Cloudflare account
wrangler d1 create onlooker
```

Wrangler will output:
```
✅ Successfully created DB 'onlooker' in Cloudflare D1
Database ID: abc123-def456-ghi789
```

2. **Update wrangler.toml**

```toml
[env.production]
d1_databases = [
  { binding = "DB", database_name = "onlooker", database_id = "abc123-def456-ghi789" }
]
```

3. **Run Initial Migration on Production**

```bash
# Execute migration against production database
wrangler d1 execute onlooker --remote < packages/db/migrations/0001_create_auth_tables.sql --env production
```

### Subsequent Migrations

For any new migrations in production:

```bash
# Apply migration to production
wrangler d1 execute onlooker --remote < packages/db/migrations/0002_your_migration.sql --env production
```

### Backup Before Major Migrations

For safety, export the database before making breaking changes:

```bash
# Export database as SQL dump
wrangler d1 execute onlooker --remote --command ".dump" > backup-2024-11-21.sql
```

## Future Migration Workflow

### Adding New Tables/Columns

As the schema evolves, use this workflow:

1. **Update schema.ts**

```typescript
// packages/db/src/schema.ts
export const myNewTable = sqliteTable("my_new_table", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

2. **Generate Migration File**

```bash
cd packages/db

# Generate migration SQL based on schema changes
pnpm run generate:migrations
```

This creates a new file in `migrations/` like `0002_add_my_new_table.sql`.

3. **Review and Run Migration**

```bash
# Review the generated migration
cat migrations/0002_add_my_new_table.sql

# Run locally
wrangler d1 execute onlooker --local < migrations/0002_add_my_new_table.sql

# Verify
wrangler d1 execute onlooker --local --command ".schema my_new_table"
```

4. **Commit Migration**

```bash
git add packages/db/migrations/0002_add_my_new_table.sql
git add packages/db/src/schema.ts
git commit -m "feat(db): add my_new_table"
```

5. **Deploy to Production**

```bash
wrangler d1 execute onlooker --remote < packages/db/migrations/0002_add_my_new_table.sql --env production
```

### Modifying Columns

For column modifications (type changes, nullability, etc.):

1. SQLite has limitations; some changes may require:
   - Create new table with correct schema
   - Copy data
   - Drop old table
   - Rename new table

2. Example migration for adding a column:

```sql
-- migrations/0003_add_optional_field.sql
ALTER TABLE users ADD COLUMN last_login TEXT;
CREATE INDEX users_last_login_idx ON users(last_login);
```

3. Example migration for complex changes (rename column):

```sql
-- migrations/0004_rename_column.sql
-- SQLite doesn't support ALTER COLUMN, so we must:
-- 1. Create new table with correct schema
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  email_verified TEXT,
  deleted_at TEXT,
  last_login_at TEXT  -- renamed from last_login
);

-- 2. Copy data (mapping old column to new)
INSERT INTO users_new 
SELECT id, email, password_hash, name, created_at, email_verified, deleted_at, last_login 
FROM users;

-- 3. Drop old table
DROP TABLE users;

-- 4. Rename new table
ALTER TABLE users_new RENAME TO users;

-- 5. Recreate indexes
CREATE UNIQUE INDEX users_email_idx ON users(email);
CREATE INDEX users_created_at_idx ON users(created_at);
CREATE INDEX users_deleted_at_idx ON users(deleted_at);
CREATE INDEX users_last_login_at_idx ON users(last_login_at);
```

## Troubleshooting

### Database File Corrupted

```bash
# Remove corrupted local database
rm -rf .wrangler/state/d1

# Recreate database
wrangler d1 create onlooker --local

# Re-run initial migration
wrangler d1 execute onlooker --local < packages/db/migrations/0001_create_auth_tables.sql
```

### Migration Fails with "Table Already Exists"

If a migration fails partway through and leaves the database in an inconsistent state:

```bash
# Check what tables exist
wrangler d1 execute onlooker --local --command ".tables"

# Manually delete the incomplete table
wrangler d1 execute onlooker --local --command "DROP TABLE users;"

# Re-run the migration
wrangler d1 execute onlooker --local < packages/db/migrations/0001_create_auth_tables.sql
```

### "No such table" Error

Migrations weren't applied. Run the initial migration:

```bash
wrangler d1 execute onlooker --local < packages/db/migrations/0001_create_auth_tables.sql
```

### Drizzle Kit Generation Fails

If `pnpm run generate:migrations` fails:

1. Ensure `drizzle.config.ts` is correct
2. Verify `wrangler.toml` exists in monorepo root
3. Check that the database exists locally

```bash
cd packages/db
pnpm run generate:migrations
```

### Wrangler Command Not Found

Install Wrangler:

```bash
# Via mise
mise use wrangler@latest

# Or globally
npm install -g wrangler

# Or from project
npx wrangler d1 --help
```

## Development Workflow

Here's the recommended workflow for schema changes:

```bash
# 1. Make changes to packages/db/src/schema.ts
# 2. Generate migrations
cd packages/db
pnpm run generate:migrations

# 3. Review generated migration
cat migrations/000X_your_migration.sql

# 4. Test locally
cd ../../
wrangler d1 execute onlooker --local < packages/db/migrations/000X_your_migration.sql

# 5. Verify with queries
wrangler d1 execute onlooker --local --command "SELECT * FROM users LIMIT 1;"

# 6. Rebuild and test API with new schema
pnpm run build

# 7. Commit
git add packages/db/
git commit -m "feat(db): describe your change :rocket:"

# 8. Deploy to production
git push
# CI/CD runs production migrations automatically
```

## Migrations Checklist

Before pushing migration to production:

- [ ] Tested locally with `wrangler d1 execute onlooker --local`
- [ ] Verified table creation with `.schema <table_name>`
- [ ] Checked foreign key relationships are correct
- [ ] Ensured indexes are created for performance
- [ ] Backed up production database
- [ ] Reviewed migration SQL for syntax errors
- [ ] Confirmed no data loss for existing records
- [ ] Updated documentation if schema changes
- [ ] Committed migration file to git
