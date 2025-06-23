#!/bin/bash
# Copyright 2025 The Chromium Authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.

# Start the MCP server with tRPC

set -e

cd "$(dirname "$0")"

echo "🚀 Starting DevTools MCP Server with tRPC..."
echo "📦 Installing dependencies..."

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    npm install
fi

echo "🔧 Building TypeScript..."
npx tsc --noEmit

echo "🌐 Starting tRPC server on http://localhost:3000..."
echo "   - HTTP endpoints: /createSession, /sendMessage"
echo "   - SSE subscriptions: /subscribeToMessages"
echo "   - Health check: /ping"
echo ""
echo "🔐 API Key Configuration:"
echo "   - Default API Key: devtools-mcp-key-2024"
echo "   - Set custom key: export MCP_API_KEY=your-custom-key"
echo "   - Localhost requests bypass API key requirement"
echo ""
echo "💡 Use 'npm run trpc-server' for development with auto-reload"
echo ""

npm run trpc-server