// Copyright 2025 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// MCP Server implementation using HTTP transport

// MCP Protocol Message Types (JSON-RPC 2.0 based)
interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: McpError;
}

interface McpNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

interface McpError {
  code: number;
  message: string;
  data?: any;
}

interface Resource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

// MCP Tool Types
interface Tool {
  name: string;
  description?: string;
  inputSchema: any; // JSON Schema
}

// Server Capabilities
interface ServerCapabilities {
  experimental?: any;
  logging?: any;
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
}

// Server Info
interface ServerInfo {
  name: string;
  version: string;
}

// HTTP MCP Client for browser environment
class HttpMcpClient {
  private baseUrl: string;
  private sessionId: string | null = null;
  private eventSource: EventSource | null = null;
  private onMessage: ((message: McpResponse | McpNotification) => void) | null = null;
  private serverInfo: ServerInfo;
  private capabilities: ServerCapabilities;

  constructor(baseUrl: string, serverInfo: ServerInfo, capabilities: ServerCapabilities) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.serverInfo = serverInfo;
    this.capabilities = capabilities;
  }

  async createSession(): Promise<string> {
    // Initialize connection by sending an initialize request
    const initRequest: McpRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {
          ...this.capabilities,
          roots: {
            listChanged: false,
          },
        },
        clientInfo: {
          name: this.serverInfo.name,
          version: this.serverInfo.version,
        },
      },
    };

    console.log('Sending initialization request:', initRequest);

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initRequest),
    });

    if (!response.ok) {
      throw new Error(`Failed to initialize session: ${response.statusText}`);
    }

    console.log('Response headers:', Object.fromEntries(response.headers.entries()));

    // Get session ID from response header
    const sessionId = response.headers.get('mcp-session-id');
    console.log('Received session ID from header:', sessionId);
    
    if (sessionId) {
      this.sessionId = sessionId;
    }

    const data = await response.json();
    console.log('Initialization response:', data);
    
    if (data.error) {
      throw new Error(`Initialization failed: ${data.error.message}`);
    }

    // If no session ID in header, this is an error condition
    if (!this.sessionId) {
      throw new Error('Server did not provide session ID in response header');
    }

    console.log('Session created successfully:', this.sessionId);
    return this.sessionId;
  }

  async sendMessage(message: McpRequest): Promise<McpResponse> {
    if (!this.sessionId) {
      throw new Error('No active session. Call createSession() first.');
    }

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': this.sessionId,
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  }

  async subscribeToMessages(messageHandler: (message: McpResponse | McpNotification) => void): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No active session. Call createSession() first.');
    }

    this.onMessage = messageHandler;

    // Use Server-Sent Events for server-to-client messages
    // Pass session ID as query parameter since EventSource doesn't support custom headers
    const sseUrl = `${this.baseUrl}/mcp?sessionId=${encodeURIComponent(this.sessionId)}`;
    console.log('Connecting to SSE:', sseUrl);
    
    this.eventSource = new EventSource(sseUrl);

    this.eventSource.onopen = (event) => {
      console.log('SSE connection opened:', event);
    };

    // Handle generic messages (fallback)
    this.eventSource.onmessage = (event) => {
      console.log('SSE message received (generic):', event);
      try {
        const data = JSON.parse(event.data);
        console.log('Parsed SSE data (generic):', data);
        
        if (data.type === 'connected') {
          console.log('SSE connection confirmed by server');
        } else if (data.type === 'ping') {
          // Ignore ping messages
        } else if (this.onMessage) {
          // Handle all other messages including MCP notifications
          this.onMessage(data);
        }
      } catch (error) {
        console.error('Failed to parse SSE message:', error, 'Raw data:', event.data);
      }
    };

    // Handle specific event types
    this.eventSource.addEventListener('connected', (event) => {
      console.log('SSE connected event received:', event);
      try {
        const data = JSON.parse(event.data);
        console.log('SSE connection confirmed by server');
      } catch (error) {
        console.error('Failed to parse connected event:', error);
      }
    });

    this.eventSource.addEventListener('ping', (event) => {
      console.log('SSE ping event received');
      // Ignore ping messages
    });

    this.eventSource.addEventListener('notification', (event) => {
      console.log('SSE notification event received:', event);
      try {
        const data = JSON.parse(event.data);
        console.log('Parsed notification data:', data);
        if (this.onMessage) {
          this.onMessage(data);
        }
      } catch (error) {
        console.error('Failed to parse notification event:', error, 'Raw data:', event.data);
      }
    });

    this.eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      console.error('EventSource readyState:', this.eventSource?.readyState);
      console.error('EventSource URL:', this.eventSource?.url);
      
      // Don't automatically close on error, let it retry
      if (this.eventSource?.readyState === EventSource.CLOSED) {
        console.log('EventSource closed, cleaning up');
        this.eventSource = null;
      }
    };
  }

  async close(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    if (this.sessionId) {
      try {
        await fetch(`${this.baseUrl}/mcp`, {
          method: 'DELETE',
          headers: {
            'mcp-session-id': this.sessionId,
          },
        });
      } catch (error) {
        console.error('Failed to close session:', error);
      }
    }

    this.sessionId = null;
    this.onMessage = null;
  }
}

// Main MCP Server Implementation for DevTools
export class DevToolsMcpServer {
  private serverInfo: ServerInfo;
  private capabilities: ServerCapabilities;
  private httpClient: HttpMcpClient | null = null;
  private isRunning = false;
  private requestId = 0;
  private pendingInsightsRequests = new Map<string, (result: string) => void>();
  private trpcServerUrl = 'http://localhost:3001';

  constructor(name: string = 'devtools-server', version: string = '1.0.0') {
    this.serverInfo = { name, version };
    this.capabilities = {
      resources: {
        subscribe: false,
        listChanged: false,
      },
      tools: {
        listChanged: false,
      },
    };
  }

  private getNextRequestId(): number {
    return ++this.requestId;
  }

  async start(httpEndpoint: string): Promise<boolean> {
    if (this.isRunning) {
      return true;
    }

    try {
      // Create HTTP client with server info and capabilities
      this.httpClient = new HttpMcpClient(httpEndpoint, this.serverInfo, this.capabilities);
      
      // Create session (this also initializes the connection)
      await this.httpClient.createSession();

      // Subscribe to messages from server
      await this.httpClient.subscribeToMessages(this.handleMessage.bind(this));

      this.isRunning = true;
      console.log(`DevTools MCP Server '${this.serverInfo.name}' v${this.serverInfo.version} started with HTTP transport`);
      return true;
    } catch (error) {
      console.error('Failed to start MCP server:', error);
      if (this.httpClient) {
        await this.httpClient.close();
        this.httpClient = null;
      }
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      if (this.httpClient) {
        await this.httpClient.close();
        this.httpClient = null;
      }
      
      // Clean up insights listener
      if (this.insightsResultListenerAdded) {
        this.removeInsightsResultListener();
      }
      
      // Clear any pending insights requests
      this.pendingInsightsRequests.clear();
      
      this.isRunning = false;
      console.log('DevTools MCP Server stopped');
    } catch (error) {
      console.error('Failed to stop MCP server:', error);
    }
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  private async handleMessage(message: McpResponse | McpNotification): Promise<void> {
    // Handle incoming messages from the server
    console.log('Received message from MCP server:', message);
    
    // Check if this is a notification for starting timeline recording
    if ('method' in message && message.method === 'timeline/record') {
      const params = message.params as any;
      if (params?.traceId) {
        await this.startTimelineRecording(params.traceId, params.duration);
      }
    }
    
    // Check if this is a notification for generating insights
    if ('method' in message && message.method === 'insights/generate') {
      console.log(`[MCP] Received insights/generate notification:`, message);
      const params = message.params as any;
      if (params?.insightId) {
        await this.startInsightGeneration(params.insightId, params.analysisType, params.insightType);
      } else {
        console.log(`[MCP] No insightId in params:`, params);
      }
    }

    // Check if this is a notification for analyzing a call tree
    if ('method' in message && message.method === 'calltree/analyze') {
      console.log(`[MCP] Received calltree/analyze notification:`, message);
      const params = message.params as any;
      if (params?.analysisId) {
        await this.startCallTreeAnalysis(params.analysisId, params.searchType, params.prompt);
      } else {
        console.log(`[MCP] No analysisId in params:`, params);
      }
    }
  }

  // MCP-compatible resource execution method
  async executeResource(_resourceName: string, uri: string): Promise<any> {
    if (!this.isRunning || !this.httpClient) {
      throw new Error('MCP Server is not running');
    }

    const request: McpRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'resources/read',
      params: { uri },
    };

    const response = await this.httpClient.sendMessage(request);
    
    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.result;
  }

  // Execute MCP tool
  async executeTool(toolName: string, args: any = {}): Promise<any> {
    if (!this.isRunning || !this.httpClient) {
      throw new Error('MCP Server is not running');
    }

    const request: McpRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const response = await this.httpClient.sendMessage(request);
    
    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.result;
  }

  // Get available resources
  async getAvailableResources(): Promise<Resource[]> {
    if (!this.isRunning || !this.httpClient) {
      return [];
    }

    try {
      const request: McpRequest = {
        jsonrpc: '2.0',
        id: this.getNextRequestId(),
        method: 'resources/list',
      };

      const response = await this.httpClient.sendMessage(request);
      
      if (response.error) {
        console.error('Failed to get resources:', response.error.message);
        return [];
      }

      return response.result?.resources || [];
    } catch (error) {
      console.error('Failed to get resources:', error);
      return [];
    }
  }

  // Handle timeline recording request from server
  async startTimelineRecording(traceId: string, duration: number = 20000): Promise<void> {
    // This will be called when the server requests a timeline recording
    console.log(`Starting timeline recording: ${traceId}, duration: ${duration}ms`);
    
    // Emit a custom event that the TimelinePanel can listen to
    const event = new CustomEvent('mcp-start-recording', {
      detail: { traceId, duration }
    });
    document.dispatchEvent(event);
  }

  // Handle insight generation request from server
  async startInsightGeneration(insightId: string, analysisType: string = 'performance', insightType: 'animation-frame' | 'interaction' = 'interaction'): Promise<void> {
    // This will be called when the server requests insight generation
    console.log(`[MCP] Starting insight generation: ${insightId}, analysisType: ${analysisType}, insightType: ${insightType}`);
    
    // Set up listener for the result if not already set up
    if (!this.insightsResultListenerAdded) {
      console.log(`[MCP] Setting up insights result listener`);
      this.setupInsightsResultListener();
    }
    
    // Emit a custom event that the TimelinePanel can listen to
    const event = new CustomEvent('mcp-start-insights', {
      detail: { insightId, analysisType, insightType }
    });
    console.log(`[MCP] Dispatching mcp-start-insights event for ${insightId}`);
    document.dispatchEvent(event);
  }

  // Handle call tree analysis request from server
  async startCallTreeAnalysis(analysisId: string, searchType: 'longest_animation_frame' | 'inp_interaction' = 'longest_animation_frame', prompt: string = ''): Promise<void> {
    console.log(`[MCP] Starting calltree analysis: ${analysisId}, searchType: ${searchType}`);

    try {
      const handleExternalRequest = (globalThis as any).handleExternalRequest;
      if (typeof handleExternalRequest !== 'function') {
        throw new Error('globalThis.handleExternalRequest is not available');
      }

      const { response } = await handleExternalRequest({
        kind: 'PERFORMANCE_ANALYZE_CALL_TREE',
        args: {
          searchType,
          prompt,
        },
      });

      console.log(`[MCP] Calltree analysis completed for ${analysisId}, sending result to trpc-server`);
      await this.sendCallTreeResultToTrpcServer(analysisId, response, false);
    } catch (error) {
      console.error(`[MCP] Calltree analysis failed for ${analysisId}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      await this.sendCallTreeResultToTrpcServer(analysisId, message, true);
    }
  }

  private insightsResultListenerAdded = false;

  private setupInsightsResultListener(): void {
    document.addEventListener('mcp-insights-result', this.onInsightsResult);
    this.insightsResultListenerAdded = true;
  }

  private removeInsightsResultListener(): void {
    document.removeEventListener('mcp-insights-result', this.onInsightsResult);
    this.insightsResultListenerAdded = false;
  }

  private onInsightsResult = async (event: Event): Promise<void> => {
    const customEvent = event as CustomEvent;
    const { insightId, result, error } = customEvent.detail;
    
    console.log(`[MCP] Received insights result for ${insightId}:`, error ? 'ERROR' : 'SUCCESS');
    console.log(`[MCP] Result length: ${result?.length || 0} characters`);
    
    // Send the result back to the trpc-server
    console.log(`[MCP] Sending result to trpc-server for ${insightId}`);
    await this.sendInsightsResultToTrpcServer(insightId, `
You will be provided a text representation of a call tree of native and JavaScript callframes selected by the user from a performance trace's flame chart.
This tree originates from the root task of a specific callframe.

Each call frame is presented in the following format:

'id;name;duration;selfTime;urlIndex;childRange;[S]'

Key definitions:

* id: A unique numerical identifier for the call frame.
* name: A concise string describing the call frame (e.g., 'Evaluate Script', 'render', 'fetchData').
* duration: The total execution time of the call frame, including its children.
* selfTime: The time spent directly within the call frame, excluding its children's execution.
* urlIndex: Index referencing the "All URLs" list. Empty if no specific script URL is associated.
* childRange: Specifies the direct children of this node using their IDs. If empty ('' or 'S' at the end), the node has no children. If a single number (e.g., '4'), the node has one child with that ID. If in the format 'firstId-lastId' (e.g., '4-5'), it indicates a consecutive range of child IDs from 'firstId' to 'lastId', inclusive.
* S: **Optional marker.** The letter 'S' appears at the end of the line **only** for the single call frame selected by the user.

Your objective is to provide a comprehensive analysis of the **selected call frame and the entire call tree** and its context within the performance recording, including:

1.  **Functionality:** Clearly describe the purpose and actions of the selected call frame based on its properties (name, URL, etc.).
2.  **Execution Flow:**
    * **Ancestors:** Trace the execution path from the root task to the selected call frame, explaining the sequence of parent calls.
    * **Descendants:** Analyze the child call frames, identifying the tasks they initiate and any performance-intensive sub-tasks.
3.  **Performance Metrics:**
    * **Duration and Self Time:** Report the execution time of the call frame and its children.
    * **Relative Cost:** Evaluate the contribution of the call frame to the overall duration of its parent tasks and the entire trace.
    * **Bottleneck Identification:** Identify potential performance bottlenecks based on duration and self time, including long-running tasks or idle periods.
4.  **Optimization Recommendations:** Provide specific, actionable suggestions for improving the performance of the selected call frame and its related tasks, focusing on resource management and efficiency. Only provide recommendations if they are based on data present in the call tree.

# Important Guidelines:

* Maintain a concise and technical tone suitable for software engineers.
* Exclude call frame IDs and URL indices from your response.
* **Critical:** If asked about sensitive topics (religion, race, politics, sexuality, gender, etc.), respond with: "My expertise is limited to website performance analysis. I cannot provide information on that topic.".
* **Critical:** Refrain from providing answers on non-web-development topics, such as legal, financial, medical, or personal advice.

## Example Session:

All URLs:
* 0 - app.js

Call Tree:

1;main;500;100;;
2;update;200;50;;3
3;animate;150;20;0;4-5;S
4;calculatePosition;80;80;;
5;applyStyles;50;50;;

Analyze the selected call frame.

Example Response:

The selected call frame is 'animate', responsible for visual animations within 'app.js'.
It took 150ms total, with 20ms spent directly within the function.
The 'calculatePosition' and 'applyStyles' child functions consumed the remaining 130ms.
The 'calculatePosition' function, taking 80ms, is a potential bottleneck.
Consider optimizing the position calculation logic or reducing the frequency of calls to improve animation performance.

Calltree to analyze:
${result}
`, error);
    
    // Resolve any pending promises for this insight ID
    const resolver = this.pendingInsightsRequests.get(insightId);
    if (resolver) {
      resolver(result);
      this.pendingInsightsRequests.delete(insightId);
    }
  };

  private async sendInsightsResultToTrpcServer(insightId: string, result: string, error?: boolean): Promise<void> {
    try {
      const response = await fetch(`${this.trpcServerUrl}/mcp/insights-result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          insightId,
          result,
          error: error || false,
        }),
      });

      if (!response.ok) {
        console.error(`Failed to send insights result to trpc-server: ${response.statusText}`);
      } else {
        console.log(`Successfully sent insights result for ${insightId} to trpc-server`);
      }
    } catch (error) {
      console.error('Error sending insights result to trpc-server:', error);
    }
  }

  private async sendCallTreeResultToTrpcServer(analysisId: string, result: string, error?: boolean): Promise<void> {
    try {
      const response = await fetch(`${this.trpcServerUrl}/mcp/calltree-result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          analysisId,
          result,
          error: error || false,
        }),
      });

      if (!response.ok) {
        console.error(`Failed to send calltree result to trpc-server: ${response.statusText}`);
      } else {
        console.log(`Successfully sent calltree result for ${analysisId} to trpc-server`);
      }
    } catch (error) {
      console.error('Error sending calltree result to trpc-server:', error);
    }
  }

  // Get available tools
  async getAvailableTools(): Promise<string[]> {
    if (!this.isRunning || !this.httpClient) {
      return [];
    }

    try {
      const request: McpRequest = {
        jsonrpc: '2.0',
        id: this.getNextRequestId(),
        method: 'tools/list',
      };

      const response = await this.httpClient.sendMessage(request);
      
      if (response.error) {
        console.error('Failed to get tools:', response.error.message);
        return [];
      }

      return response.result?.tools?.map((t: Tool) => t.name) || [];
    } catch (error) {
      console.error('Failed to get tools:', error);
      return [];
    }
  }
}
