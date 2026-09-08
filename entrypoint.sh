#!/bin/bash

PUID=${PUID:-1000}
PGID=${PGID:-1000}
OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD:-}

if [ "$(id -g node)" -ne "$PGID" ]; then
    groupmod -o -g "$PGID" node
fi

if [ "$(id -u node)" -ne "$PUID" ]; then
    usermod -o -u "$PUID" node
fi

chown -R node:node /home/node/.local/share/opencode
chown -R node:node /home/node/.config/opencode
chown -R node:node /home/node/project

# Allow overriding via environment variables
PROXY_PORT=${OPENCODE_PROXY_PORT:-10000}
SERVER_PORT=${OPENCODE_SERVER_PORT:-10001}

if [[ "${OPENCODE_PROXY_PROMPT_MODE:-standard}" == "plugin-inject" ]]; then
    echo "Preparing opencode2api plugin-inject prompt mode..."
    mkdir -p /home/node/.config/opencode/plugin/opencode2api-empty
    cat > /home/node/.config/opencode/plugin/opencode2api-empty/index.js <<'EOF'
export const Opencode2apiEmptyPlugin = async () => ({})
export default Opencode2apiEmptyPlugin
EOF
    cat > /home/node/.config/opencode/opencode.json <<'EOF'
{
  "plugin": ["/home/node/.config/opencode/plugin/opencode2api-empty/index.js"],
  "instructions": [],
  "theme": "system"
}
EOF
    chown -R node:node /home/node/.config/opencode
fi

if [[ "$1" == "opencode" && "$2" == "serve" ]]; then
    echo "Initializing OpenCode-to-OpenAI (Server + Proxy)"
    
    echo "Starting OpenCode Server on internal port ${SERVER_PORT}..."
    gosu node opencode serve --hostname 0.0.0.0 --port ${SERVER_PORT} &
    SERVER_PID=$!
    
    echo "Waiting for OpenCode Server to become available..."
    # Cold start on small (1GB) hosts can take minutes; do not kill early.
    # Budget: 90 x 2s sleep ~= 180s when the backend refuses fast (normal
    # cold start; covered by compose start_period 200s). If the backend
    # accepts but hangs every probe, each round costs up to curl -m 5 + 2s
    # sleep (worst case ~630s) — that means the backend itself is wedged,
    # not slow, and the container will exit 1 so it can be rescheduled.
    MAX_RETRIES=90
    RETRY_DELAY=2
    COUNT=0
    while ! curl -s -m 5 http://127.0.0.1:${SERVER_PORT}/health > /dev/null; do
        if [ $COUNT -ge $MAX_RETRIES ]; then
            echo "Timeout waiting for OpenCode Server."
            kill $SERVER_PID 2>/dev/null
            exit 1
        fi

        if ! kill -0 $SERVER_PID 2>/dev/null; then
            echo "OpenCode Server process died unexpectedly."
            exit 1
        fi

        sleep $RETRY_DELAY
        COUNT=$((COUNT+1))
    done
    echo "OpenCode Server is up!"

    echo "Starting OpenAI Proxy on port ${PROXY_PORT}..."
    exec gosu node node index.js
else
    exec gosu node "$@"
fi