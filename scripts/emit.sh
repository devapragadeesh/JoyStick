#!/bin/sh
# joystick event shim.
#
# Reads a Claude Code hook JSON payload on stdin and POSTs it verbatim to the
# local sidecar. Invoked as an async command hook, so Claude Code never waits
# on it.
#
# Invariants:
#   - Always exits 0. A non-zero exit from an async hook can surface to the
#     user; a dead sidecar must be indistinguishable from no plugin at all.
#   - The payload is never interpolated into the command line. It moves from
#     stdin to curl's request body without passing through the shell.
#   - Loopback only, and --noproxy defeats any HTTP_PROXY that would otherwise
#     route session contents off this machine.

PORT="${CLAUDE_PLUGIN_OPTION_PORT:-8787}"

# Escape hatch: `export JOYSTICK_DISABLED=1` makes the shim a no-op without
# uninstalling the plugin. Used by the benchmark harness.
if [ -n "${JOYSTICK_DISABLED}" ]; then
  exit 0
fi

curl \
  --silent \
  --output /dev/null \
  --noproxy '*' \
  --connect-timeout 1 \
  --max-time 5 \
  --header 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${PORT}/events" \
  >/dev/null 2>&1

exit 0
