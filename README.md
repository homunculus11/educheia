# Tekwill App – Development Guide

Quick setup and workflow for local development.

## Prerequisites

- Node.js 18+ (recommended)
- npm

## Install dependencies

```bash
npm install
```

## Development workflow

1. Start Tailwind watch mode:

```bash
npm run watch:css
```

2. Open the app in the browser:
   - Main page: `index.html`
   - Other pages: `prototype.html`, `src/login.html`

You can open files directly, but using a local static server (for example VS Code Live Server) is recommended during development.

## Build CSS only

```bash
npm run build:css
```

This discovers all `*.tailwind.css` files in the workspace and compiles each one to a matching `.css` file (same path, same filename without `.tailwind`).

Examples:

- `css/index.tailwind.css` → `css/index.css`
- `css/prototype.tailwind.css` → `css/prototype.css`

## Build production artifact (Pages-like)

```bash
npm run build
```

This command runs the same build flow used by Pages automation:

1. Compiles Tailwind CSS with minification
2. Creates a clean `dist/` folder
3. Copies deployable files/folders (`assets`, `images`, `js`, `src`, `index.html`, `prototype.html` when present)
4. Copies only compiled CSS files to `dist/css` (excludes `*.tailwind.css`)
5. Fingerprints all `.js` and `.css` files in `dist/` and rewrites references in HTML and JS imports

The build also writes `dist/asset-manifest.json` so you can verify source-to-fingerprinted mapping.

## Production caching strategy

For safe long-term caching without stale deploys:

1. Keep HTML non-cacheable or short-lived (`no-cache` / low max-age)
2. Cache fingerprinted JS/CSS aggressively (`max-age=31536000, immutable`)
3. If using Cloudflare, use **Standard** cache behavior (do not cache HTML unless explicitly required)

With fingerprinted assets, each deploy changes file names automatically when content changes, so browsers/CDN fetch new files without manual cache purges.

## Deploy to GitHub Pages (auto build + publish)

This repository includes a workflow at `.github/workflows/pages.yml` that:

1. Installs dependencies
2. Runs `npm run build` (full production artifact build)
3. Publishes the built static site to GitHub Pages

### One-time setup in GitHub

1. Push the repo to GitHub (default branch should be `main`)
2. Open **Settings → Pages**
3. Set **Source** to **GitHub Actions**
4. Push to `main` (or run workflow manually from Actions tab)

The site artifact includes:

- `index.html`
- `prototype.html`
- `assets/`, `css/`, `images/`, `js/`, `src/`

## Notes for project Pages URLs

When hosted at `https://<user>.github.io/<repo>/`, root-absolute links like `/login` break.
Use repository-safe relative/hash links in HTML (already applied in `index.html`).

## Firebase Auth production checklist

For Google Sign-In to work in production (and localhost), configure Firebase before deploy:

1. Open **Firebase Console → Authentication → Sign-in method**
2. Enable **Google** provider
3. Open **Firebase Console → Authentication → Settings → Authorized domains**
4. Add every domain where the app runs, for example:
   - `localhost`
   - `<your-user>.github.io`
   - any custom production domain

Important:

- Do not run auth pages from `file://`; use a web server (`http://localhost:...` or deployed HTTPS domain).
- If Google popup is blocked by browser policies, the app automatically falls back to redirect login.

## Project structure

- `index.html` – main landing page
- `prototype.html` – extra/prototype page
- `src/login.html` – login page
- `src/signup.html` – signup page
- `src/episodes.html` – episodes page scaffold
- `src/about.html` – about/themes page scaffold
- `js/script.js` – frontend behavior and data fetch logic
- `css/styles.css` – shared design tokens (colors and related CSS variables)
- `*.tailwind.css` – Tailwind source styles (auto-discovered)
- `css/index.css` – generated CSS used by `index.html` and `src/login.html` (do not edit manually)
- `css/prototype.css` – generated CSS used by `prototype.html` (do not edit manually)
- `tailwind.config.js` – Tailwind config and content scan paths

## Notes

- `npm run watch:css` automatically picks up new `*.tailwind.css` files and starts watching them.
- The project uses Tailwind utility classes plus custom theme tokens from the config.
