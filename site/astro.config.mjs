// A static site that works under any path of a domain: pages link to each other and to the game with relative
// addresses (src/lib/paths.ts), styles are inlined, and no script bundle is emitted — so nothing in the output
// names the root of the host.
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always', assets: 'assets' },
  devToolbar: { enabled: false },
  vite: { server: { fs: { allow: ['..'] } } },
});
