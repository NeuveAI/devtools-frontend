#!/usr/bin/env node
// Copyright 2025 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { serve } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';

// Create MCP server with DevTools capabilities
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'devtools-server',
    version: '1.0.0'
  });

  // Register DevTools trace recording resource
  server.registerResource(
    'trace-record',
    'devtools://trace/record/default',
    {
      name: 'Default Trace Recording',
      description: 'Record a default performance trace in Chrome DevTools',
      mimeType: 'application/json'
    },
    async (uri: URL) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          traceId: 'default',
          status: 'recording',
          message: 'Trace recording started successfully (simulated)',
          startTime: Date.now(),
          maxDuration: 20000,
          events: []
        }, null, 2)
      }]
    })
  );

  // Register DevTools insight resource
  server.registerResource(
    'insight',
    'devtools://insight/default',
    {
      name: 'Default Performance Insights',
      description: 'Get default performance insights from DevTools analysis',
      mimeType: 'application/json'
    },
    async (uri: URL) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          insightId: 'default',
          type: 'performance',
          message: 'Insight generation will be implemented',
          timestamp: Date.now(),
          recommendations: [],
          metrics: {}
        }, null, 2)
      }]
    })
  );

  // Register trace recording tool
  server.registerTool(
    'record_trace',
    {
      title: 'Record Performance Trace',
      description: 'Record a performance trace in Chrome DevTools and trigger timeline recording'
    },
    async (input: { traceId?: string, duration?: number }) => {
      const traceId = input.traceId || `trace-${Date.now()}`;
      const duration = input.duration || 20000;

      const result = {
        success: true,
        traceId,
        status: 'recording',
        message: 'Timeline recording started in DevTools',
        startTime: Date.now(),
        maxDuration: duration
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Register insight tool
  server.registerTool(
    'get_insight',
    {
      title: 'Get Performance Insights',
      description: 'Get performance insights from DevTools analysis data. Use "interaction" for user interaction events and responsiveness issues, or "animation-frame" for general performance bottlenecks and frame rate issues.'
    },
    async (input: { insightId?: string, analysisType?: string, insightType?: 'animation-frame' | 'interaction' }) => {
      const insightId = input.insightId || `insight-${Date.now()}`;
      const analysisType = input.analysisType || 'performance';
      const insightType = input.insightType || 'interaction';

      const result = {
        success: true,
        insightId,
        type: analysisType,
        insightType,
        message: 'Insight generation will be implemented',
        timestamp: Date.now(),
        recommendations: [],
        metrics: {}
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  return server;
}

// Session management
interface Session {
  id: string;
  server: McpServer;
  createdAt: Date;
  lastActivity: Date;
  sseController?: ReadableStreamDefaultController<Uint8Array>;
  clientType: 'mcpserver' | 'generic';
  clientInfo?: {
    name: string,
    version: string,
  };
}

const sessions = new Map<string, Session>();

// Store pending insights requests
const pendingInsightsRequests = new Map<string, (result: string) => void>();

// Helper function to send notifications only to McpServer sessions
function sendNotificationToMcpServerSessions(notification: { jsonrpc: '2.0', method: string, params: Record<string, unknown> }): void {
  let mcpServerSessionsCount = 0;
  let sentCount = 0;

  sessions.forEach((session, sessionId) => {
    if (session.clientType === 'mcpserver') {
      mcpServerSessionsCount++;

      if (session.sseController) {
        try {
          const sseMessage = `event: notification\ndata: ${JSON.stringify(notification)}\n\n`;
          session.sseController.enqueue(new TextEncoder().encode(sseMessage));
          sentCount++;
          console.log(`Sent notification to McpServer session: ${sessionId}`);
        } catch (error) {
          console.error(`Failed to send SSE notification to session ${sessionId}:`, error);
        }
      }
    }
  });

  console.log(`Notification sent to ${sentCount}/${mcpServerSessionsCount} McpServer sessions`);
}

// Create Hono app
const app = new Hono();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'mcp-session-id'],
  exposeHeaders: ['mcp-session-id'],
}));

// Helper to get or create session
function getSession(sessionId?: string, clientInfo?: { name: string, version: string }): Session {
  console.log('getSession called with:', sessionId, 'clientInfo:', clientInfo);

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    if (session) {
      console.log('Found existing session:', session.id, 'clientType:', session.clientType);
      session.lastActivity = new Date();
      return session;
    }
  }

  // Create new session
  const newSessionId = randomUUID();
  console.log('Creating new session with ID:', newSessionId);

  // Determine client type based on client info
  const clientType: 'mcpserver' | 'generic' =
    clientInfo?.name === 'devtools-server' ? 'mcpserver' : 'generic';

  const session: Session = {
    id: newSessionId,
    server: createMcpServer(),
    createdAt: new Date(),
    lastActivity: new Date(),
    clientType,
    clientInfo
  };

  sessions.set(newSessionId, session);
  console.log('Session created and stored. Total sessions:', sessions.size, 'Client type:', clientType);
  return session;
}

// Handle MCP POST requests
app.post('/mcp', async c => {
  try {
    const sessionId = c.req.header('mcp-session-id');
    console.log('Received request with session ID:', sessionId);

    const requestData = await c.req.json();
    console.log('Request method:', requestData.method);

    // Extract client info from initialize request
    let clientInfo: { name: string, version: string } | undefined;
    if (requestData.method === 'initialize' && requestData.params?.clientInfo) {
      clientInfo = requestData.params.clientInfo;
    }

    const session = getSession(sessionId, clientInfo);
    console.log('Using session:', session.id, 'clientType:', session.clientType);

    // Always set the session ID header in the response
    c.header('mcp-session-id', session.id);
    console.log('Set response header mcp-session-id to:', session.id);

    // Handle initialization
    if (requestData.method === 'initialize') {
      const response = {
        jsonrpc: '2.0' as const,
        id: requestData.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {
            resources: {
              subscribe: false,
              listChanged: false,
            },
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: 'devtools-server',
            version: '1.0.0',
          },
        },
      };

      console.log(`Session initialized: ${session.id}`);
      console.log('Returning response with headers');
      return c.json(response);
    }

    // Handle other MCP requests
    let response;

    switch (requestData.method) {
      case 'resources/list':
        response = {
          jsonrpc: '2.0' as const,
          id: requestData.id,
          result: {
            resources: [
              {
                uri: 'devtools://trace/record/default',
                name: 'Default Trace Recording',
                description: 'Record a default performance trace',
                mimeType: 'application/json',
              },
              {
                uri: 'devtools://insight/default',
                name: 'Default Insight',
                description: 'Get default performance insights',
                mimeType: 'application/json',
              },
            ],
          },
        };
        break;

      case 'resources/read': {
        const uri = requestData.params?.uri;
        if (uri === 'devtools://trace/record/default') {
          response = {
            jsonrpc: '2.0' as const,
            id: requestData.id,
            result: {
              contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  traceId: 'default',
                  status: 'recording',
                  message: 'Trace recording started successfully (simulated)',
                  startTime: Date.now(),
                  maxDuration: 20000,
                  events: []
                }, null, 2)
              }]
            }
          };
        } else if (uri === 'devtools://insight/default') {
          response = {
            jsonrpc: '2.0' as const,
            id: requestData.id,
            result: {
              contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  insightId: 'default',
                  type: 'performance',
                  message: 'Insight generation will be implemented',
                  timestamp: Date.now(),
                  recommendations: [],
                  metrics: {}
                }, null, 2)
              }]
            }
          };
        } else {
          response = {
            jsonrpc: '2.0' as const,
            id: requestData.id,
            error: {
              code: -32602,
              message: `Unknown resource: ${uri}`
            }
          };
        }
        break;
      }

      case 'tools/list':
        response = {
          jsonrpc: '2.0' as const,
          id: requestData.id,
          result: {
            tools: [
              {
                name: 'record_trace',
                description: 'Record a performance trace in Chrome DevTools',
                inputSchema: {
                  type: 'object',
                  properties: {
                    traceId: {
                      type: 'string',
                      description: 'Unique identifier for the trace recording',
                    },
                    duration: {
                      type: 'number',
                      description: 'Maximum duration in milliseconds',
                      default: 20000,
                    },
                  },
                },
              },
              {
                name: 'get_insight',
                description: 'Get performance insights from DevTools analysis data. Use "interaction" for user interaction events and responsiveness issues, or "animation-frame" for general performance bottlenecks and frame rate issues.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    insightId: {
                      type: 'string',
                      description: 'Unique identifier for the insight request',
                    },
                    analysisType: {
                      type: 'string',
                      enum: ['performance', 'memory', 'network'],
                      description: 'Type of analysis to perform',
                      default: 'performance',
                    },
                    insightType: {
                      type: 'string',
                      enum: ['animation-frame', 'interaction'],
                      description: 'Specific insight type: "interaction" for user interaction events and responsiveness issues, "animation-frame" for general performance bottlenecks and frame rate issues',
                      default: 'interaction',
                    },
                  },
                },
              },
            ],
          },
        };
        break;

      case 'tools/call': {
        const toolName = requestData.params?.name;
        const args = requestData.params?.arguments || {};

        if (toolName === 'record_trace') {
          const traceId = args.traceId || `trace-${Date.now()}`;
          const duration = args.duration || 20000;

          // Send timeline/record notification only to McpServer sessions via SSE
          sendNotificationToMcpServerSessions({
            jsonrpc: '2.0' as const,
            method: 'timeline/record',
            params: { traceId, duration }
          });

          response = {
            jsonrpc: '2.0' as const,
            id: requestData.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  traceId,
                  status: 'recording',
                  message: 'Timeline recording started in DevTools',
                  startTime: Date.now(),
                  maxDuration: duration
                }, null, 2)
              }]
            }
          };
        } else if (toolName === 'get_insight') {
          const insightId = args.insightId || `insight-${Date.now()}`;
          const analysisType = args.analysisType || 'performance';
          const insightType = args.insightType || 'interaction';

          console.log(`[TRPC] Starting insight generation for ${insightId}, analysisType: ${analysisType}, insightType: ${insightType}`);

          // Send insights/generate notification to McpServer sessions via SSE
          sendNotificationToMcpServerSessions({
            jsonrpc: '2.0' as const,
            method: 'insights/generate',
            params: { insightId, analysisType, insightType }
          });

          console.log(`[TRPC] Sent notification for ${insightId}, waiting for response...`);
          console.log(`[TRPC] Current pending requests: ${Array.from(pendingInsightsRequests.keys())}`);

          // Wait for the actual insights result from the callback
          const insightsResult = await new Promise<string>(resolve => {
            // Set up a timeout for the insights generation
            const timeout = setTimeout(() => {
              console.log(`[TRPC] Timeout reached for ${insightId}, cleaning up`);
              pendingInsightsRequests.delete(insightId);
              resolve('Timeout: Unable to generate insights within expected time');
            }, 30000); // 30 second timeout

            // Store the resolver so it can be called when the result arrives
            const wrappedResolve = (result: string) => {
              console.log(`[TRPC] Received result for ${insightId}: ${result.substring(0, 100)}...`);
              clearTimeout(timeout);
              resolve(result);
            };

            pendingInsightsRequests.set(insightId, wrappedResolve);
            console.log(`[TRPC] Stored resolver for ${insightId}, total pending: ${pendingInsightsRequests.size}`);
          });

          console.log(`[TRPC] Final result for ${insightId}: ${insightsResult.substring(0, 100)}...`);

          response = {
            jsonrpc: '2.0' as const,
            id: requestData.id,
            result: {
              content: [{
                type: 'text',
                text: insightsResult
              }]
            }
          };
        } else {
          response = {
            jsonrpc: '2.0' as const,
            id: requestData.id,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`
            }
          };
                 }
         break;
       }

      default:
        response = {
          jsonrpc: '2.0' as const,
          id: requestData.id,
          error: {
            code: -32601,
            message: `Unknown method: ${requestData.method}`
          }
        };
    }

    return c.json(response);

  } catch (error) {
    console.error('Error handling MCP request:', error);
    return c.json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
        data: error instanceof Error ? error.message : String(error)
      },
      id: null
    }, 500);
  }
});

// Handle GET requests for SSE (optional - for server-to-client messages)
app.get('/mcp', c => {
  console.log('GET /mcp request received');
  console.log('Query parameters:', c.req.query());
  console.log('Request headers available');

  // Get session ID from query parameter for SSE connections
  const sessionId = c.req.query('sessionId') || c.req.header('mcp-session-id');
  console.log('Looking for session ID:', sessionId);
  console.log('Available sessions:', Array.from(sessions.keys()));
  console.log('Session exists?', sessionId ? sessions.has(sessionId) : 'No session ID');

  if (!sessionId || !sessions.has(sessionId)) {
    console.log('Invalid session ID, returning 400');
    return c.json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Invalid session ID'
      },
      id: null
    }, 400);
  }

  console.log('Setting up manual SSE stream for session:', sessionId);

  // Set SSE headers manually
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Cache-Control');

  console.log('SSE headers set, creating readable stream');

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      console.log(`SSE connection established for session: ${sessionId}`);

      // Store the controller in the session for sending notifications
      const session = sessions.get(sessionId);
      if (session) {
        session.sseController = controller;
      }

      // Send initial connection confirmation
      const connectMessage = `event: connected\ndata: ${JSON.stringify({ type: 'connected', sessionId, timestamp: Date.now() })}\n\n`;
      controller.enqueue(new TextEncoder().encode(connectMessage));
      console.log('Sent connection confirmation');

      // Keep connection alive with ping
      const pingInterval = setInterval(() => {
        try {
          const pingMessage = `event: ping\ndata: ${JSON.stringify({ type: 'ping', timestamp: Date.now() })}\n\n`;
          controller.enqueue(new TextEncoder().encode(pingMessage));
          console.log('Sent ping');
        } catch (error) {
          console.error('Error sending ping:', error);
          clearInterval(pingInterval);
          controller.close();
        }
      }, 30000);

      // Store cleanup function
      const cleanup = () => {
        console.log(`SSE connection closed for session: ${sessionId}`);
        clearInterval(pingInterval);

        // Remove the controller reference from the session
        const session = sessions.get(sessionId);
        if (session) {
          session.sseController = undefined;
        }
                 try {
           controller.close();
         } catch {
           // Controller might already be closed
         }
      };

      // Handle client disconnect
      c.req.raw.signal?.addEventListener('abort', cleanup);

             // Store cleanup for later use if needed
       (controller as ReadableStreamDefaultController & { cleanup?: () => void }).cleanup = cleanup;
    },

    cancel() {
      console.log(`SSE stream cancelled for session: ${sessionId}`);
      // Cleanup will be handled by the abort event
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    }
  });
});

// Handle insights result callback from McpServer
app.post('/mcp/insights-result', async c => {
  try {
    const { insightId, result, error } = await c.req.json();

    console.log(`[TRPC] Received insights result for ${insightId}:`, error ? 'ERROR' : 'SUCCESS');
    console.log(`[TRPC] Result length: ${result?.length || 0} characters`);
    console.log(`[TRPC] Pending requests before: ${Array.from(pendingInsightsRequests.keys())}`);

    // Resolve any pending promises for this insight ID
    const resolver = pendingInsightsRequests.get(insightId);
    if (resolver) {
      console.log(`[TRPC] Found resolver for ${insightId}, calling it...`);
      resolver(error ? `Error: ${result}` : result);
      pendingInsightsRequests.delete(insightId);
      console.log(`[TRPC] Resolved and removed ${insightId}, remaining: ${Array.from(pendingInsightsRequests.keys())}`);
    } else {
      console.log(`[TRPC] No resolver found for ${insightId}. Available resolvers: ${Array.from(pendingInsightsRequests.keys())}`);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Error handling insights result:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// Handle session termination
app.delete('/mcp', c => {
  const sessionId = c.req.header('mcp-session-id');

  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
    return c.text('', 200);
  }

  return c.text('', 404);
});

// Health check endpoint
app.get('/ping', c => {
  return c.json({
    message: 'pong',
    timestamp: new Date().toISOString(),
    sessions: sessions.size
  });
});

// Start the server
async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  console.log(`🚀 MCP Server running on http://localhost:${port}/mcp`);
  console.log('📡 Streamable HTTP transport ready');
  console.log('🔗 Endpoint: POST/GET http://localhost:3000/mcp');
  console.log('💓 Health check: GET http://localhost:3000/ping');

  serve({
    fetch: app.fetch,
    port
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
