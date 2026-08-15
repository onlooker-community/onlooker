# Web App Deployment Guide

Deployment guide for Onlooker Web App to Cloudflare Pages.

## Overview

The web app is a **Vite + React** application that deploys to **Cloudflare Pages**.

- **Framework:** Vite (build tool) + React (UI)
- **Language:** TypeScript
- **Target:** Cloudflare Pages (static hosting with edge functions)
- **Regions:** Global (cached at Cloudflare edge)

## Configuration

### wrangler.toml

The Pages app is configured via `wrangler.toml`:

```toml
name = "onlooker-web"
compatibility_date = "2024-12-16"

[assets]
directory = "dist"

[env.staging]
routes = [
  { pattern = "app-staging.onlooker.dev/*", zone_name = "onlooker.dev" }
]

[env.production]
routes = [
  { pattern = "app.onlooker.dev/*", zone_name = "onlooker.dev" }
]
```

Routes and the assets directory, and nothing else. There is no `main`, so this
is a static-assets Worker with no code of ours running on request.

### Environment Variables

Build-time variables are prefixed with `VITE_` and live in `.env.<mode>` files,
**not** in `wrangler.toml`. Vite inlines them at build time, so a var declared
here would be read by nothing — this app has no runtime to read it, and the
value is already baked into the bundle by then either way.

That distinction is not pedantic. `wrangler.toml` used to declare a
per-environment `VITE_API_URL`, which looked like per-environment API routing
and was not: one bundle built against `api.onlooker.dev` shipped to both
hostnames, so `app-staging.onlooker.dev` read and wrote the production database.

```env
# apps/web/.env.production
VITE_API_BASE_URL=https://api.onlooker.dev
```

Access in code via `resolveApiConfig()` in `src/api/config.ts`.

### Build Configuration

**File:** `vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
```

## Deployment

### Build

```bash
# Build the app
pnpm --filter @onlooker/web build

# This runs:
# 1. TypeScript type-check (tsc --noEmit)
# 2. Vite build (vite build)

# Output is in: dist/
```

### Deploy via Wrangler

```bash
# Deploy to production
pnpm --filter @onlooker/web deploy --env production

# Deploy to staging
pnpm --filter @onlooker/web deploy --env staging

# Deploy to development
pnpm --filter @onlooker/web deploy --env development
```

### Local Development

```bash
# Start dev server with hot reload
pnpm --filter @onlooker/web dev

# Server runs on http://localhost:5173
```

### Manual Deployment via Dashboard

1. Go to https://dash.cloudflare.com/
2. Pages section
3. Create/Connect project
4. Set build command: `pnpm build`
5. Set output directory: `dist`
6. Set build-time variables (`VITE_API_BASE_URL`) — they must be present at
   build time, not added as runtime vars afterward
7. Deploy

## API Integration

### Configuring API URL

The API URL changes per environment, which means the *build* changes per
environment — the URL is inlined and cannot be redirected afterward:

```bash
# Development (local): apps/web/.env.development -> http://localhost:8787
pnpm --filter @onlooker/web dev

# Staging: apps/web/.env.staging -> https://api-staging.onlooker.dev
pnpm --filter @onlooker/web build:staging

# Production: apps/web/.env.production -> https://api.onlooker.dev
pnpm --filter @onlooker/web build
```

Each build command ends by reading its own output and failing if the bundle
calls anything other than the API that mode is named for
(`scripts/verify-api-target.mjs`). It also fails when the bundle names no API at
all — an unset `VITE_API_BASE_URL` drops the app onto its in-memory mock, which
looks healthy while serving invented data. `pnpm deploy:web:staging` and
`pnpm deploy:web:prod` each run their own build, so neither can ship a bundle
another deploy left in `dist/`.

### Using API URL in Code

Create a API client:

```typescript
// src/api/client.ts
import { resolveApiConfig } from "./config";

const { baseUrl } = resolveApiConfig();

export async function loginUser(email: string, password: string) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    credentials: 'include',
  });
  
  if (!response.ok) {
    throw new Error(`Login failed: ${response.statusText}`);
  }
  
  return response.json();
}

export async function fetchUser(token: string) {
  const response = await fetch(`${baseUrl}/api/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch user: ${response.statusText}`);
  }
  
  return response.json();
}
```

Use in components:

```typescript
// src/components/LoginForm.tsx
import { loginUser } from '../api/client';

export function LoginForm() {
  const handleLogin = async (email: string, password: string) => {
    try {
      const { token } = await loginUser(email, password);
      localStorage.setItem('auth_token', token);
    } catch (error) {
      console.error('Login error:', error);
    }
  };
  
  return (
    // ... form JSX
  );
}
```

## Performance

### Optimization

1. **Asset caching** — Cloudflare caches all static assets at edge
2. **Code splitting** — Vite automatically splits code for faster loads
3. **Image optimization** — Optimize images before deployment
4. **Lazy loading** — Use React.lazy() for route-based code splitting

### Caching Headers

Cloudflare automatically sets cache headers:
- HTML: No cache (always fresh)
- JS/CSS: Long cache (1 year)
- Images: Long cache (1 year)

### Cache Busting

Vite automatically adds hashes to filenames:
- `main.abc123.js` — Hash changes on code update
- When you deploy, old versions are pushed out

## Monitoring

### Logs

1. Cloudflare Dashboard → Pages → onlooker-web → Deployments
2. Click deployment to see build logs
3. View runtime errors in browser console

### Analytics

1. Cloudflare Dashboard → Pages → onlooker-web → Analytics
2. View traffic, caching, and performance metrics

### Real-Time Logs

For live debugging (coming soon):
```bash
pnpm --filter @onlooker/api exec wrangler tail --env production
```

## Build Artifacts

### Output Structure

```
dist/
├── index.html              # Entry point
├── assets/
│   ├── main.abc123.js      # JavaScript (hashed)
│   ├── main.def456.css     # CSS (hashed)
│   ├── react.xyz789.js     # React library
│   └── ...
└── ...
```

### File Types

- **HTML** — Not cached (checked on every request)
- **JS/CSS** — Cached forever (hashed filenames)
- **Images** — Cached long-term

## Troubleshooting

### Build fails with "the bundle calls no API at all"

**Cause:** `VITE_API_BASE_URL` was unset for the mode being built, usually a
missing `.env.<mode>` file. Left unchecked this does not fail — the app quietly
falls back to its in-memory mock and serves invented data.

**Solution:** set it in the `.env` file for that mode.
```env
# apps/web/.env.production
VITE_API_BASE_URL=https://api.onlooker.dev
```

### App loads but API calls fail (CORS error)

**Cause:** API not accepting requests from your domain

**Solution:**
1. Check API CORS_ORIGIN matches web domain:
   ```toml
   # apps/api/wrangler.toml
   [env.production.vars]
   CORS_ORIGIN = "https://app.onlooker.dev"
   ```

2. Check what the deployed bundle actually calls, not what config says:
   ```bash
   curl -s https://app.onlooker.dev/ | grep -o '/assets/index-[^"]*\.js'
   curl -s https://app.onlooker.dev/assets/index-XXXX.js \
     | grep -o 'https://api[a-z-]*\.onlooker\.dev' | sort -u
   ```

3. Test preflight:
   ```bash
   curl -i -X OPTIONS https://api.onlooker.dev/auth/login \
     -H 'Origin: https://app.onlooker.dev' \
     -H 'Access-Control-Request-Method: POST'
   ```

### Blank page or 404s after deployment

**Cause:** Build output not in `dist/`

**Solution:**
```bash
# Verify build output
ls -la dist/

# If empty, check build command
pnpm --filter @onlooker/web build

# Check vite.config.ts has correct output dir
```

### TypeScript errors during build

```bash
# Type-check locally
pnpm --filter @onlooker/web typecheck

# Fix errors and rebuild
pnpm --filter @onlooker/web build
```

### Styles not loading

**Cause:** CSS file path or build issue

**Solution:**
1. Verify CSS is in `dist/assets/`
2. Check Cloudflare cache headers
3. Hard refresh browser (Cmd+Shift+R)

## Custom Domain

### Setup

1. Go to Cloudflare Dashboard → Pages → onlooker-web
2. Settings → Custom Domains
3. Add domain: `app.onlooker.dev`
4. Cloudflare auto-provisions SSL certificate

### DNS

Cloudflare automatically configures DNS to point to Pages. No manual setup needed.

## Rollback

### View Deployments

1. Cloudflare Dashboard → Pages → onlooker-web → Deployments
2. See list of all deployments with timestamps

### Rollback to Previous

1. Find previous deployment
2. Click on it to view details
3. Click "Rollback" button
4. Confirm rollback

## Environment-Specific Builds

### Build for Production

```bash
# Automatically uses [env.production.vars]
pnpm --filter @onlooker/web build

# Then deploy
pnpm --filter @onlooker/web deploy --env production
```

### Build for Staging

```bash
# Reads apps/web/.env.staging and verifies the result
pnpm --filter @onlooker/web build:staging

# Build and deploy in one step
pnpm deploy:web:staging
```

## Testing

### Local Testing

```bash
# Build and preview locally
pnpm --filter @onlooker/web build
pnpm --filter @onlooker/web preview

# Runs on http://localhost:5173
```

### Test Against Live API

```bash
# The default build already targets the production API
pnpm --filter @onlooker/web build

# Preview locally
pnpm --filter @onlooker/web preview

# App talks to production API at http://localhost:5173
```

Note that this is a real client of production: anything you sign up or change
here lands in the production database. Prefer `build:staging` unless you
specifically need production.

## Related Docs

- [DEPLOYMENT.md](../../DEPLOYMENT.md) — Full deployment guide
- [ENVIRONMENT_VARIABLES.md](../../ENVIRONMENT_VARIABLES.md) — Environment reference
- [Cloudflare Pages Docs](https://developers.cloudflare.com/pages/)
- [Vite Docs](https://vitejs.dev/)
- [React Docs](https://react.dev/)

## Quick Commands

```bash
# Development
pnpm dev                           # Start dev server
pnpm build                         # Build for production
pnpm preview                       # Preview build locally
pnpm typecheck                     # Type-check
pnpm lint                          # Lint code

# Deployment (from the repository root; each builds the bundle it ships)
pnpm deploy:web:prod               # Deploy to production
pnpm deploy:web:staging            # Deploy to staging

# Testing
pnpm test                          # Run tests
```
