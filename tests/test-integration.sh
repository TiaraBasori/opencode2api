#!/bin/bash
set -euo pipefail

TEST_PORT="${TEST_PORT:-14096}"
CONTAINER_NAME="opencode2api-test-${TEST_PORT}"
INTERNAL_ALLOWED_TOOLS="${INTERNAL_ALLOWED_TOOLS:-web_fetch,filesystem}"
TOOL_DISCOVERY_FIXTURE="${TOOL_DISCOVERY_FIXTURE:-web_fetch,filesystem,bash}"

cleanup() {
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- Running Integration Tests ---"

echo "Building Docker image..."
docker build -t opencode2api:test .

echo "Starting container on port ${TEST_PORT}..."
cleanup

docker run -d --name "${CONTAINER_NAME}" \
    -p ${TEST_PORT}:10000 \
    -e API_KEY=test-key \
    -e OPENCODE_INTERNAL_ALLOWED_TOOLS="${INTERNAL_ALLOWED_TOOLS}" \
    -e OPENCODE_TOOL_DISCOVERY_FIXTURE="${TOOL_DISCOVERY_FIXTURE}" \
    opencode2api:test

echo "Waiting for service to be ready..."
MAX_RETRIES=30
COUNT=0
until curl -sf http://localhost:${TEST_PORT}/health > /dev/null 2>&1; do
    if [ $COUNT -ge $MAX_RETRIES ]; then
        echo "Timeout waiting for service."
        docker logs "${CONTAINER_NAME}"
        exit 1
    fi
    sleep 1
    COUNT=$((COUNT+1))
done
echo "Service is up!"

echo "Testing health endpoint..."
curl -sf http://localhost:${TEST_PORT}/health || { echo "Health check failed"; exit 1; }

echo "Testing models endpoint..."
MODELS_JSON=$(curl -sf -H "Authorization: Bearer test-key" http://localhost:${TEST_PORT}/v1/models)
echo "$MODELS_JSON" | grep -q "opencode" || { echo "Models check failed"; exit 1; }
MODEL_ID=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["data"][0]["id"])' <<< "$MODELS_JSON")

echo "Testing chat completion (non-streaming) with ${MODEL_ID}..."
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer test-key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}" | grep -q "chat.completion" || { echo "Chat completion failed"; exit 1; }

echo "Checking startup logs for tool discovery fixture..."
LOGS=$(docker logs "${CONTAINER_NAME}" 2>&1)
echo "$LOGS" | grep -q "Internal Allowed Tools" || { echo "Internal allowlist log missing"; exit 1; }
echo "$LOGS" | grep -q "web_fetch, filesystem" || { echo "Internal allowlist values missing"; exit 1; }
echo "$LOGS" | grep -q "Internal Tool Discovery Fixture" || { echo "Tool discovery fixture log missing"; exit 1; }
echo "$LOGS" | grep -q "web_fetch, filesystem, bash" || { echo "Tool discovery fixture values missing"; exit 1; }

echo "--- Integration Tests Passed! ---"
