#!/bin/bash

set -e

echo "--- Real Streaming Test ---"

BASE_URL="${BASE_URL:-http://localhost:10000}"
API_KEY="${API_KEY:-test-key}"

echo "Base URL: $BASE_URL"
echo ""

echo "Test 1: Streaming without Reasoning"
echo "-----------------------------------"
RESPONSE=$(curl -s -N -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "opencode/kimi-k2.5",
    "messages": [{"role": "user", "content": "Reply with 3 words"}],
    "stream": true
  }')

if echo "$RESPONSE" | grep -q "data: {"; then
    echo "✓ SSE chunks found"
else
    echo "✗ No SSE chunks"
    exit 1
fi

if echo "$RESPONSE" | grep -q "data: \[DONE\]"; then
    echo "✓ Stream finished with [DONE]"
else
    echo "✗ Stream not finished correctly"
    exit 1
fi

echo ""
echo "Test 2: Non-Streaming"
echo "-----------------------------------"
RESPONSE=$(curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "opencode/kimi-k2.5",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }')

if echo "$RESPONSE" | grep -q '"choices"'; then
    echo "✓ Valid JSON response"
else
    echo "✗ Invalid JSON response"
    exit 1
fi

if echo "$RESPONSE" | grep -q '"usage"'; then
    echo "✓ Usage field present"
else
    echo "✗ Usage field missing"
    exit 1
fi

echo ""
echo "--- All tests passed! ---"