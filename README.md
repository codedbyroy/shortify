# Shortify

A URL shortener built with TypeScript, Cloudflare Workers, and D1. The live app is branded **brief**.

**[Open Shortify](https://brief-links-roy.leggeth069.workers.dev/)** to create and manage links. Shared links use [nvux.pages.dev](https://nvux.pages.dev/).

## What it does

- Creates five-letter, pronounceable short names, or lets you choose your own 4–5 character word.
- Shows a navy-and-white destination page for five seconds, then opens the original URL, preserving query strings and fragments.
- Includes a countdown, progress bar, and Stay here control; without JavaScript, a manual Continue to site link remains available.
- Adds subtle entrance and interaction animations, respecting reduced-motion preferences.
- Shows each browser its latest 100 links and total click counts.
- Lets that browser remove its own links after confirmation.
- Keeps links in Cloudflare D1 across deployments and restarts.
- Limits creation to 30 links per IP per calendar hour. Redirects remain available.

No account is required. A random, HttpOnly cookie identifies a browser's history; the database stores its hash. Clearing cookies or changing browsers loses management access to old links. Short links remain public and functional until removed. This is a first version for light use; it does not include accounts, cross-device sync, destination screening, or recovery of lost browser histories. Click counts measure GET requests, including bots and link previews, rather than unique people.

## Local development

Use Node 22.12+ or a supported newer release.

```sh
npm ci
npm run db:local
npm run dev
```

Open the local address printed by Wrangler, usually `http://localhost:8787`. Database state is under `.wrangler/` and is excluded from version control.

```sh
npm run check
npm test
npm run build
```

Tests run the real Worker and SQLite-backed D1 emulator. They cover creation, the destination page and safe URL rendering, older codes, clicks, ownership isolation, deletion, conflicting aliases, validation, cross-origin writes, request-size limits, rate limiting, and static content. Separate deterministic browser-script checks verify the full five-second delay, exact destination, pause control, and restoration from browser history.

## Deploy to Cloudflare

Cloudflare Workers hosts the app and D1 stores links. This project is sized for light usage on the free plan; the account's current quotas and billing settings apply. It does not enable a paid plan or purchase a domain.

1. Sign in to your Cloudflare account. For first-time accounts, finish account setup and choose a Workers subdomain in the dashboard.
2. Authorize the CLI in the same account:

   ```sh
   npx wrangler login
   ```

3. Set your Worker and database names in `wrangler.jsonc`. For your own public deployment, replace the canonical homepage in `src/site.ts` and `public/index.html` with your Worker URL.
4. Run:

   ```sh
   npm run deploy
   ```

The script creates a D1 database when `database_id` is the initial all-zero placeholder, writes its real ID to `wrangler.jsonc`, applies migrations, then deploys the Worker and static assets. Subsequent deploys reuse that database. If creation succeeds but the script cannot save the returned ID, copy the database ID from the dashboard into the config before retrying. It does not delete or replace an existing database.

The final output includes the public Worker URL. Keep Wrangler login credentials and local database files outside version control.

## Verify the live deployment

1. Open `/health`; expect `{"status":"ok"}`.
2. Create a test link to `https://example.com/?source=brief#test`.
3. Open it; confirm brief shows the destination and a five-second countdown before the destination opens with its query and fragment unchanged. Try Stay here on a second visit; confirm it pauses and Continue to site works.
4. Refresh the dashboard and confirm its click count increased.
5. Open the app in another browser; confirm its history is empty.
6. Remove the test link, then confirm opening it shows the 404 page.
7. Check the home page on a narrow screen; ensure the form and link actions fit.

## Implementation

`public/` is plain HTML, CSS, and JavaScript. `src/index.ts` handles the API, cookie-based ownership, and destination pages. `public/redirect.js` waits at least five seconds after it starts before opening the destination. `migrations/` contains the D1 schema. Every query with user input uses bound parameters. The app never fetches destination URLs. Responses include a restrictive content policy; destination-page text and attributes are escaped. Destination pages are not cached so deletion and visit counts take effect immediately. A GET visit to that page counts once, even when the visitor pauses; HEAD does not count. Visitors already on the page can still continue if a link is subsequently deleted.

New custom words use 4–5 ASCII letters or numbers, normalized to lowercase and unique without case sensitivity. Existing 3–32 character links continue to resolve and can still be deleted. Automatic names alternate consonants and vowels over five letters (102,400 possibilities), chosen with cryptographic randomness, with database-enforced uniqueness and up to 20 collision retries. This smaller name space suits light use; short links are public, guessable addresses rather than access controls. A larger service would need longer codes. New copies use the configured sharing origin and the same 4–5-character path. Creation requires a same-origin request and a valid browser cookie. Rate-limit buckets hash the IP and hour; raw IP addresses are not stored. Database failures return a generic message and do not log URLs or cookies.

## Operations

### Enable a shorter sharing address

The live Pages project serves aliases over HTTPS from the same Worker and D1 database. Its root redirects to the homepage, where visitors create and manage links.

1. Create a Direct Upload Pages project in the Worker's Cloudflare account using `npx wrangler pages project create NAME --production-branch main`. Check the assigned hostname in the project details.
2. Set the Pages project name and the bound Worker's service name in `pages/wrangler.jsonc`. From this directory, run `npx wrangler pages deploy --cwd pages --branch main`.
3. Before giving anyone the address, verify its TLS, the 308 from its root to the old homepage, a known alias on both hosts, the countdown, its script and stylesheet, and the exact destination. A HEAD request checks an alias without increasing its click count.
4. Set `vars.SHORT_LINK_ORIGIN` in the main `wrangler.jsonc` to the verified HTTPS origin. Run `npm run check`, `npm test`, and `npm run build`, then `npx wrangler deploy` from this directory. No migrations are needed for this change. Both Copy buttons use the URL returned by this Worker.
5. From the homepage, create a disposable link, copy it, open it, verify its click count, then delete it and check for a 404 on both hosts. Check prior history in the same browser.

To switch newly copied links back, remove `SHORT_LINK_ORIGIN` and redeploy the main Worker. Keep the Pages project serving previously shared links.

Back up the database using the Cloudflare dashboard or `wrangler d1 export DB --remote --output <private-backup-path>`. A backup contains destination URLs and should be stored privately. A Workers rollback changes code only; it does not roll back D1. This initial schema is additive. Future migrations should preserve existing short codes.
