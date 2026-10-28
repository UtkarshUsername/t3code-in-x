# T3 Code in X

A static, interactive demo of T3 Code. It runs the original React frontend against a small environment in the browser. There is no T3 server, account, provider credential, or AI request.

## Run locally

Use the Node version in `package.json` and [Vite+](https://viteplus.dev).

```sh
vp i
vp run demo:dev
```

Open the URL printed by Vite. The two fictional projects include completed, settled, and unfinished conversations. Use the existing picker to choose a provider and model. Messages cycle through eight scenarios in order, independently of the selected model: feature work, a search fix, an autosave review, a schema migration, a test-strategy question, a project tour, a failing-test repair, or a two-turn design/build sequence. The second design/build turn continues on your next message before the cycle advances. After all eight scenarios, the cycle starts again. Progress is shared across threads for this visit and resets on refresh. The seeded empty-state design thread is ready for its implementation turn. Model names are demo labels; responses, tool output, and diffs are scripted.

Thinking streams, plans update, and tools move from running to completed. Clarification questions pause the replay until you answer. Stopping a turn cancels its pending questions. All of these interactions use the original T3 Code controls.

While a replay is running, steer to interrupt it and play the next scenario, or queue messages to play subsequent scenarios in order. The queue supports editing, reordering, cancellation, and promotion to steer. Stopping a turn holds its queue until you send a queued message now or resume it.

Thread creation, follow-ups, cancellation, renaming, settling/reopening, archiving, deletion, file browsing, and diffs run locally. Operations requiring a real environment, such as shell execution, git pushes, pairing, and provider installation, report that they are unavailable. The frontend components and layout are unchanged.

All demo state, preferences, and drafts are temporary. Refreshing restores the seeded workspace. There is no persistent database or browser-storage requirement.

## Build and host

```sh
vp run demo:build
vp run demo:preview
```

The deployable directory is **`apps/web/dist-demo`**. The Cloudflare Pages project is **`t3code-in-x`**, targeting [t3code-in-x.pages.dev](https://t3code-in-x.pages.dev). Cloudflare builds the private GitHub repository's `main` branch.

Cloudflare build settings:

- Root directory: repository root.
- Build command: `npx --yes vite-plus@1.4.0 install --frozen-lockfile --filter=@t3tools/web... --filter=@t3tools/scripts... && npx --yes vite-plus@1.4.0 run demo:build`.
- Output directory: `apps/web/dist-demo`.
- Build environment: `NODE_VERSION=26.12.1`, `SKIP_DEPENDENCY_INSTALL=1`, and `DEMO_PUBLIC_URL=https://t3code-in-x.pages.dev`.

Push to `main` to publish an update. The public URL must be set during the build so the X card points to the deployed site.

The build includes Cloudflare Pages `_headers` and `_redirects` files. It does not need a Worker, API, database, or WebSocket server. The ordinary upstream web build remains separate.

## X Player Card

Set **`DEMO_PUBLIC_URL`** to the deployed HTTPS origin when building, for example `https://your-demo.pages.dev`. This adds server-readable Player Card metadata pointing to the static demo, with a 640 x 480 player and `/demo-preview.png` as its preview image. Rebuild after changing the public URL.

Post the deployed site's URL. The card requests an inline player; X controls whether and where it displays. Test the hosted URL in X before announcing it. The demo can also be used directly in a normal browser tab. This repository does not establish X's policy approval for interactive Player Cards.

## Checks

```sh
vp test run apps/web/src/demo/environment.test.ts
vp run --filter @t3tools/web typecheck
vp run check:changed
```

## Source and license

Based on [pingdotgg/t3code](https://github.com/pingdotgg/t3code), upstream snapshot `5211acfe95a0c6d82a60e2524b5e46b47fe67a3e`. This is an independent demo repository, not the official hosted T3 Code app. Original copyright and [MIT license](LICENSE) are preserved. The static build retains third-party license notices.
