import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    // Exercise the default origin independently of the production sharing host.
    // The short-host integration test supplies its own SHORT_LINK_ORIGIN.
    miniflare: { bindings: { SHORT_LINK_ORIGIN: '' } },
  })],
});
