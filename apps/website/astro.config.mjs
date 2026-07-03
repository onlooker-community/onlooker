// @ts-check
import { defineConfig, envField } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  env: {
    schema: {
      SITE_LAUNCHED: envField.boolean({
        context: 'server',
        access: 'public',
        default: false,
      }),
    },
  },
});