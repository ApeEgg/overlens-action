#!/bin/sh
# Crawls the fixture site with the engine end to end, laid out the way the
# workflow lays out a consumer: config at the root, engine in .overlens.
set -e
cd "$(dirname "$0")"
rm -rf .overlens && mkdir .overlens && cp -R ../crawler .overlens/crawler
bun install --cwd .overlens/crawler
bun -e 'Bun.serve({ port: 4173, fetch: (r) => new Response(Bun.file(`site${new URL(r.url).pathname.replace(/^\/$/, "/index")}.html`), { headers: { "content-type": "text/html" } }) })' &
trap 'kill $!' EXIT
cd .overlens/crawler
OVERLENS=1 PLAYWRIGHT_BASE_URL=http://localhost:4173 bunx playwright test overlens.spec
find overlens-output -type f | sort
