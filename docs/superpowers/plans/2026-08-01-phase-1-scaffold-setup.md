# Phase 1: Scaffold Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create minimal, working monorepo scaffolds for web app, API, and auth packages so that `pnpm dev` and `pnpm build` succeed across all new apps/packages.

**Architecture:** Start with minimal entry points and configuration files for each new app/package. Wire up Turbo tasks so builds happen in the correct dependency order. No features yet—just the scaffolding and build pipeline.

**Tech Stack:** pnpm workspace, Turbo, TypeScript, React + Vite (web), Node.js (API), Biome (linting), shared config packages

## Global Constraints

- Use pnpm workspace linked dependencies (`workspace:*`)
- Extend shared Biome configs from `@onlooker/config-biome`
- Extend shared TypeScript configs from `@onlooker/config-typescript`
- All new packages follow naming convention `@onlooker/<name>`
- Node version: `>=20.19.0 <21 || >=22.12.0 <23 || >=24.0.0 <25`
- pnpm version: `11.0.9`

---

## File Structure Map

### New Files to Create

```
apps/
├── web/
│   ├── package.json
│   ├── tsconfig.json
│   ├── biome.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       └── App.tsx

api/
├── package.json
├── tsconfig.json
├── biome.json
└── src/
    └── index.ts

packages/
├── auth-core/
│   ├── package.json
│   ├── tsconfig.json
│   ├── biome.json
│   └── src/
│       └── index.ts

└── auth-react/
    ├── package.json
    ├── tsconfig.json
    ├── biome.json
    └── src/
        └── index.ts
```

### Files to Modify

- `turbo.json` — Add dev, build, test, lint, typecheck tasks for new apps/packages
- Root `package.json` — Add dev:setup and other tasks if needed (optional for Phase 1)

---

## Task 1: Create `apps/web` Scaffold (React + Vite)

**Beads Issue:** onlooker-s3h

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/biome.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `@onlooker/config-biome`, `@onlooker/config-typescript`
- Produces: React app entry point at `src/main.tsx`, dev and build tasks for Turbo

### Steps

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@onlooker/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "biome check src",
    "lint:fix": "biome check --write src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@onlooker/config-biome": "workspace:*",
    "@onlooker/config-typescript": "workspace:*",
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
```

- [ ] **Step 2: Create `apps/web/tsconfig.json`**

```json
{
  "extends": "@onlooker/config-typescript/react-library.json",
  "compilerOptions": {
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `apps/web/biome.json`**

```json
{
  "root": false,
  "extends": ["@onlooker/config-biome/react.json"]
}
```

- [ ] **Step 4: Create `apps/web/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
```

- [ ] **Step 5: Create `apps/web/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Onlooker</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `apps/web/src/main.tsx`**

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 7: Create `apps/web/src/App.tsx`**

```typescript
export default function App() {
  return (
    <div>
      <h1>Onlooker Web App</h1>
      <p>Scaffold ready for feature development.</p>
    </div>
  );
}
```

- [ ] **Step 8: Verify scaffold structure**

Run from root:
```bash
ls -la apps/web/
```

Expected: All files listed above exist.

- [ ] **Step 9: Commit**

```bash
git add apps/web/
/commit  # Use the commit skill
```

---

## Task 2: Create `apps/api` Scaffold (Node Server)

**Beads Issue:** onlooker-r3l

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/biome.json`
- Create: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `@onlooker/config-biome`, `@onlooker/config-typescript`
- Produces: Node.js server entry point at `src/index.ts`, dev and build tasks for Turbo

### Steps

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@onlooker/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc --noEmit && esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js",
    "start": "node dist/index.js",
    "lint": "biome check src",
    "lint:fix": "biome check --write src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@onlooker/config-biome": "workspace:*",
    "@onlooker/config-typescript": "workspace:*",
    "@types/node": "^25.9.3",
    "esbuild": "^0.23.0",
    "tsx": "^4.22.4",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

```json
{
  "extends": "@onlooker/config-typescript/base.json",
  "compilerOptions": {
    "module": "ESNext",
    "target": "ES2022",
    "lib": ["ES2022"],
    "moduleResolution": "bundler"
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `apps/api/biome.json`**

```json
{
  "root": false,
  "extends": ["@onlooker/config-biome/library.json"]
}
```

- [ ] **Step 4: Create `apps/api/src/index.ts`**

```typescript
const PORT = 3000;

console.log(`API server starting on port ${PORT}...`);
console.log("Scaffold ready for endpoint development.");

// Placeholder: Server startup will be added in Phase 2
```

- [ ] **Step 5: Verify scaffold structure**

Run from root:
```bash
ls -la apps/api/
```

Expected: All files listed above exist.

- [ ] **Step 6: Commit**

```bash
git add apps/api/
/commit
```

---

## Task 3: Create `packages/auth-core` Scaffold

**Beads Issue:** onlooker-3p6

**Files:**
- Create: `packages/auth-core/package.json`
- Create: `packages/auth-core/tsconfig.json`
- Create: `packages/auth-core/biome.json`
- Create: `packages/auth-core/src/index.ts`

**Interfaces:**
- Consumes: `@onlooker/config-biome`, `@onlooker/config-typescript`
- Produces: Auth core logic exports (placeholder for now), zero external dependencies

### Steps

- [ ] **Step 1: Create `packages/auth-core/package.json`**

```json
{
  "name": "@onlooker/auth-core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "lint": "biome check src",
    "lint:fix": "biome check --write src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@onlooker/config-biome": "workspace:*",
    "@onlooker/config-typescript": "workspace:*",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Create `packages/auth-core/tsconfig.json`**

```json
{
  "extends": "@onlooker/config-typescript/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `packages/auth-core/biome.json`**

```json
{
  "root": false,
  "extends": ["@onlooker/config-biome/library.json"]
}
```

- [ ] **Step 4: Create `packages/auth-core/src/index.ts`**

```typescript
// Auth core logic placeholders
// Session management, token handling, validation will be added in Phase 2

export interface User {
  id: string;
  email: string;
}

export interface Session {
  userId: string;
  token: string;
  expiresAt: Date;
}

// Placeholder exports
export const validateSession = (token: string): boolean => {
  // Implementation in Phase 2
  return true;
};

export const createSession = (userId: string): Session => {
  // Implementation in Phase 2
  return {
    userId,
    token: "",
    expiresAt: new Date(),
  };
};
```

- [ ] **Step 5: Verify scaffold structure**

Run from root:
```bash
ls -la packages/auth-core/
```

Expected: All files listed above exist.

- [ ] **Step 6: Commit**

```bash
git add packages/auth-core/
/commit
```

---

## Task 4: Create `packages/auth-react` Scaffold

**Beads Issue:** onlooker-2he

**Files:**
- Create: `packages/auth-react/package.json`
- Create: `packages/auth-react/tsconfig.json`
- Create: `packages/auth-react/biome.json`
- Create: `packages/auth-react/src/index.ts`

**Interfaces:**
- Consumes: `@onlooker/auth-core`, `@onlooker/config-biome`, `@onlooker/config-typescript`
- Produces: React auth hooks and context provider (placeholder for now)

### Steps

- [ ] **Step 1: Create `packages/auth-react/package.json`**

```json
{
  "name": "@onlooker/auth-react",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "lint": "biome check src",
    "lint:fix": "biome check --write src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@onlooker/auth-core": "workspace:*",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@onlooker/config-biome": "workspace:*",
    "@onlooker/config-typescript": "workspace:*",
    "@types/react": "^18.3.1",
    "typescript": "^5.6.3"
  },
  "peerDependencies": {
    "react": "^18.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/auth-react/tsconfig.json`**

```json
{
  "extends": "@onlooker/config-typescript/react-library.json",
  "compilerOptions": {
    "outDir": "dist",
    "declaration": true,
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `packages/auth-react/biome.json`**

```json
{
  "root": false,
  "extends": ["@onlooker/config-biome/react.json"]
}
```

- [ ] **Step 4: Create `packages/auth-react/src/index.ts`**

```typescript
import React, { createContext, useContext } from "react";
import type { Session, User } from "@onlooker/auth-core";

// Auth context placeholder
interface AuthContextType {
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Implementation in Phase 2
  return <>{children}</>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
```

- [ ] **Step 5: Verify scaffold structure**

Run from root:
```bash
ls -la packages/auth-react/
```

Expected: All files listed above exist.

- [ ] **Step 6: Commit**

```bash
git add packages/auth-react/
/commit
```

---

## Task 5: Wire Turbo Tasks and Workspace Dependencies

**Beads Issue:** onlooker-uig

**Files:**
- Modify: `turbo.json` — Add tasks for new apps/packages
- Modify: `pnpm-workspace.yaml` — Already configured; verify
- Modify: Root `package.json` (optional) — Add dev:setup if not present

**Interfaces:**
- Consumes: All tasks from Tasks 1-4
- Produces: Working Turbo task pipeline, `pnpm dev` and `pnpm build` succeed

### Steps

- [ ] **Step 1: Review current `turbo.json`**

Run from root:
```bash
cat turbo.json
```

Expected output includes task definitions like `dev`, `build`, `lint`, `typecheck`, with dependencies configured.

- [ ] **Step 2: Update `turbo.json` to include new apps/packages in task graph**

Edit `turbo.json` to ensure `dev`, `build`, `lint`, `typecheck` tasks are defined for the new packages. If they don't exist, add them:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["**/.env.local", ".env"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "outputs": []
    },
    "typecheck": {
      "outputs": []
    },
    "test": {
      "outputs": ["coverage/**"],
      "cache": false
    }
  }
}
```

Note: This assumes basic task structure. Review existing `turbo.json` and merge if it has additional configuration.

- [ ] **Step 3: Verify `pnpm-workspace.yaml` includes new apps/packages**

Run from root:
```bash
cat pnpm-workspace.yaml
```

Expected output:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

If correct, no changes needed. If missing or different, update accordingly.

- [ ] **Step 4: Install dependencies and link workspace packages**

Run from root:
```bash
pnpm install
```

Expected: pnpm links all workspace packages, no errors.

- [ ] **Step 5: Verify TypeScript configuration across all packages**

Run from root:
```bash
pnpm typecheck
```

Expected: All TypeScript files compile without errors (or with expected placeholder warnings).

- [ ] **Step 6: Verify Biome linting passes**

Run from root:
```bash
pnpm lint
```

Expected: No Biome errors. Warnings are OK for this phase.

- [ ] **Step 7: Verify `pnpm dev` starts all services**

Run from root:
```bash
pnpm dev
```

Expected: 
- `apps/website` dev server starts
- `apps/web` Vite dev server starts (port 5173)
- `apps/api` watcher starts (tsx watch src/index.ts)
- `packages/auth-core` watcher starts
- `packages/auth-react` watcher starts

Let it run for a few seconds, then kill it (Ctrl+C).

- [ ] **Step 8: Verify `pnpm build` succeeds**

Run from root:
```bash
pnpm build
```

Expected: 
- All packages build successfully
- `apps/web/dist/` directory created with built assets
- `packages/auth-core/dist/` and `packages/auth-react/dist/` created
- No errors

- [ ] **Step 9: Commit**

```bash
git add turbo.json pnpm-workspace.yaml
/commit
```

- [ ] **Step 10: Final verification — list all new workspaces**

Run from root:
```bash
pnpm ls --depth=0
```

Expected output includes:
```
@onlooker/web@0.0.1
@onlooker/api@0.0.1
@onlooker/auth-core@0.0.1
@onlooker/auth-react@0.0.1
```

---

## Verification Checklist

- [ ] `pnpm install` completes without errors
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes (or only warnings)
- [ ] `pnpm dev` starts all services without errors
- [ ] `pnpm build` succeeds and creates dist directories for all new apps/packages
- [ ] Each beads issue has been claimed and closed: `bd close onlooker-s3h onlooker-r3l onlooker-3p6 onlooker-2he onlooker-uig`
- [ ] All commits follow conventional commit format (via `/commit` skill)

---

## Summary

Phase 1 establishes the monorepo scaffolding: minimal, working apps and packages with Turbo tasks wired. No features are implemented yet—this is foundation only. Once this phase is complete, Phase 2 (Auth Foundation) can begin by extracting and integrating actual auth logic from the existing `onlooker-app` codebase.
