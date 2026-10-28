# T3 Code in X

A static, interactive demo of T3 Code. It runs the original React frontend against a small environment in the browser. There is no T3 server, account, provider credential, or AI request.

## Run locally

Use the Node version in `package.json` and [Vite+](https://viteplus.dev).

```sh
vp i
vp run demo:dev
```

Open the URL printed by Vite. The two fictional projects include completed, settled, and unfinished conversations. Use the existing picker to choose a provider and model. Each message randomly plays a feature, bug-fix, or review scenario, independently of the selected model. Send messages in those conversations or create a new thread. Model names are demo labels; responses, tool output, and diffs are scripted.

Thread creation, follow-ups, cancellation, renaming, settling/reopening, archiving, deletion, file browsing, and diffs run locally. Operations requiring a real environment, such as shell execution, git pushes, pairing, and provider installation, report that they are unavailable. The frontend components and layout are unchanged.

All demo state, preferences, and drafts are temporary. Refreshing restores the seeded workspace. There is no persistent database or browser-storage requirement.

## Build and host

```sh
vp run demo:build
vp run demo:preview
```

The deployable directory is **`apps/web/dist-demo`**. Upload that directory to a static host, or connect this repository to Cloudflare Pages with:

- Build command: `vp run demo:build` after installing dependencies with `vp i`.
- Build output directory: `apps/web/dist-demo`.
- Repository root as the working directory.
- Node version matching `package.json`.

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
