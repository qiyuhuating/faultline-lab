#!/bin/sh
set -eu
cd "$(dirname "$0")"
node -e 'const p=process.versions.node.split(".").map(Number);if(p[0]!==24||p[1]<15){console.error("Install Node.js 24.15+ (24.x)");process.exit(1)}'
exec node src/server.mjs "$@"
