#!/bin/bash
set -e

TEST_PORT="${TEST_PORT:-14096}"
CONTAINER_NAME="opencode2api-test-${TEST_PORT}"

echo "--- Running Integration Tests ---"

echo "Building Docker image..."
docker build -t opencode2api:test .

echo "Starting container on port ${TEST_PORT}..."
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run -d --name "${CONTAINER_NAME}" \
    -p ${TEST_PORT}:10000 \
    -e API_KEY=test-key \
    opencode2api:test

echo "Waiting for service to be ready..."
MAX_RETRIES=30
COUNT=0
until curl -sf http://localhost:${TEST_PORT}/health > /dev/null 2>&1; do
    if [ $COUNT -ge $MAX_RETRIES ]; then
        echo "Timeout waiting for service."
        docker logs "${CONTAINER_NAME}"
        docker rm -f "${CONTAINER_NAME}"
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

echo "Cleaning up..."
docker rm -f "${CONTAINER_NAME}"

echo "--- Integration Tests Passed! ---"
