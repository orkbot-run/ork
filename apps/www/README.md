<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Marketing site

## EasyPanel

Set Build Path to `/`, Dockerfile to `apps/www/Dockerfile`, and container port to
`80`. Required build-time environment variables: none.

The image builds the Astro static site and Pagefind index with the pnpm version
in the root `package.json`, then serves `dist` with nginx. Vercel API functions
and middleware are outside this static image, including `/api/download`.

Build and run from the repository root:

```sh
docker build -f apps/www/Dockerfile -t ork-www .
docker run --rm -p 8080:80 ork-www
```

Open <http://localhost:8080>.
