import type { Plugin } from "vite-plus";

export function demoPlugin(publicUrl: string | undefined): Plugin {
  const origin = publicUrl ? new URL(publicUrl).origin : undefined;
  return {
    name: "t3-static-demo",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "./storage" &&
        importer?.replaceAll("\\", "/").endsWith("/connection/platform.ts")
      ) {
        return new URL("../src/demo/storage.ts", import.meta.url).pathname.replace(
          /^\/(\w:)/,
          "$1",
        );
      }
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return {
          html: html.replace("/src/bootstrap.ts", "/src/demo/main.ts"),
          tags: origin
            ? [
                { tag: "meta", attrs: { name: "twitter:card", content: "player" } },
                { tag: "meta", attrs: { name: "twitter:title", content: "Try T3 Code" } },
                {
                  tag: "meta",
                  attrs: {
                    name: "twitter:description",
                    content:
                      "Explore the real T3 Code interface with browser-only replay scenarios.",
                  },
                },
                {
                  tag: "meta",
                  attrs: { name: "twitter:image", content: `${origin}/demo-preview.png` },
                },
                { tag: "meta", attrs: { name: "twitter:player", content: `${origin}/` } },
                { tag: "meta", attrs: { name: "twitter:player:width", content: "640" } },
                { tag: "meta", attrs: { name: "twitter:player:height", content: "480" } },
              ]
            : [],
        };
      },
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source:
          "/*\n  Content-Security-Policy: frame-ancestors 'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Content-Type-Options: nosniff\n",
      });
      this.emitFile({ type: "asset", fileName: "_redirects", source: "/* /index.html 200\n" });
    },
  };
}
