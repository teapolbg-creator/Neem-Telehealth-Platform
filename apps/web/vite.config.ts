// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },

  /**
   * Build for Netlify, which is where this app is hosted.
   *
   * The Lovable config's Nitro default is `cloudflare-module`, so a plain
   * `npm run build` emitted a Cloudflare Worker and a wrangler.json — an
   * artefact Netlify cannot deploy. Nothing failed loudly; the build simply
   * produced the wrong thing.
   *
   * Committed here rather than left to a `NITRO_PRESET` build variable in the
   * Netlify dashboard. A build target that depends on an environment variable
   * someone can forget is how a Cloudflare bundle ends up in a Netlify deploy,
   * and the symptom would be a site that builds successfully and does not work.
   *
   * The preset writes the SSR handler to `.netlify/functions-internal/server`
   * and the static assets, `_headers` and `_redirects` to `dist` — which is why
   * netlify.toml sets `base = "apps/web"` and `publish = "dist"`.
   */
  nitro: { preset: "netlify" },
});
