# DevTools MCP Server

A Model Context Protocol (MCP) server that provides Chrome DevTools integration functionality.

## Overview

This server exposes Chrome DevTools functionality through MCP resources, allowing AI assistants and other MCP clients to interact with DevTools features.

## Resources

### Record Trace
- **URI**: `devtools://trace/record/{traceId}`
- **Description**: Record a performance trace in Chrome DevTools
- **Status**: Placeholder implementation (to be completed)

### Get Insight
- **URI**: `devtools://insight/{insightId}`
- **Description**: Get insights from DevTools analysis
- **Status**: Placeholder implementation (to be completed)

## Installation

```bash
cd scripts/devtools-server
npm install
```

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

## Configuration

The server runs on stdio transport by default, making it suitable for integration with MCP clients like Claude Desktop.

## Next Steps

- Implement actual trace recording functionality
- Implement insight generation and analysis
- Add more DevTools resources and tools
- Add proper error handling and validation