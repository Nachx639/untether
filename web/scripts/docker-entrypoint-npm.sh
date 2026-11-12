#!/bin/sh
set -eu

exec node /app/bin/untether --bind 0.0.0.0 "$@"
