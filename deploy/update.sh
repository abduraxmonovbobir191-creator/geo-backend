#!/usr/bin/env bash
# Pulls the newest code and restarts the API with it.
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only
docker compose up -d --build
docker compose ps
