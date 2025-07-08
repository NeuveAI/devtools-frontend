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
  private trpcServerUrl = 'http://localhost:3000';

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

The format of each callframe is:

    Node: $id – $name
    Selected: true
    dur: $duration
    self: $self
    URL #: $url_number
    Children:
      * $child.id – $child.name

The fields are:

* name:  A short string naming the callframe (e.g. 'Evaluate Script' or the JS function name 'InitializeApp')
* id:  A numerical identifier for the callframe
* Selected:  Set to true if this callframe is the one the user wants analyzed.
* url_number:  The number of the URL referenced in the "All URLs" list
* dur:  The total duration of the callframe (includes time spent in its descendants), in milliseconds.
* self:  The self duration of the callframe (excludes time spent in its descendants), in milliseconds. If omitted, assume the value is 0.
* children:  An list of child callframes, each denoted by their id and name

Your task is to analyze this callframe and its surrounding context within the performance recording. Your analysis may include:
* Clearly state the name and purpose of the selected callframe based on its properties (e.g., name, URL). Explain what the task is broadly doing.
* Describe its execution context:
  * Ancestors: Trace back through the tree to identify the chain of parent callframes that led to the execution of the selected callframe. Describe this execution path.
  * Descendants:  Analyze the children of the selected callframe. What tasks did it initiate? Did it spawn any long-running or resource-intensive sub-tasks?
* Quantify performance:
    * Duration
    * Relative Cost:  How much did this callframe contribute to the overall duration of its parent tasks and the entire recorded trace?
    * Potential Bottlenecks: Analyze the total and self duration of the selected callframe and its children to identify any potential performance bottlenecks. Are there any excessively long tasks or periods of idle time?
* Based on your analysis, provide specific and actionable suggestions for improving the performance of the selected callframe and its related tasks. Are there any resources being acquired or held for longer than necessary? Only provide if you have specific suggestions and recommended research points for the user to further investigate as a next step.

# Considerations
* Keep your analysis concise and focused, highlighting only the most critical aspects for a software engineer.
* Whenever analyzing the callframes, pay attention to the URLs of each callframe and the calltree as a whole, but do not mention any chunk URL directly in your analysis. There may be some patterns and potential leads on where the biggest performance bottlenecks are by analyzing common URL sources for some common libraries recommations.
* Whenever identifying a potential source of performance issues coming from a common URL source or pattern, provide recommendations that are specific to the identified source or pattern. Thought you can provide general recommendations, those recommendations might not have the same value as specific recommendations for specific sources or patterns.
  * For instance, when certain patterns come from a specific library (either identified from the URL, identified from the callframe name or context, or directly provided by the user), provide recommendations that are tailored to help mitigate the identified issue or suggest research points for the user to further investigate if you lack enough confidence on the identified issue.

### Known URLs for resources

Urls that contain certain patterns are known to come from some common libraries and resources. Observe those patterns and use the knowledge to provide attribution to any observed patterns.

- *_next/static/chunks/* - NextJS known build assets. some emerging patterns might give hints on react specific optimizations.

**IMPORTANT:**
* Do not use Top level headings (#) in your response. But create a well formatted markdown response based on your instructions and the data provided. Open up with a ## Trace events analysis
* When mentioning duration times, be specific when refering to individual callframes duration or a total duration of a certain repeating function / callframe.
* DO NOT mention id of the callframe or the url_number in your response directly, as that information is not relevant to the user. You can use the callframe name or the URL address referred from the list of all URLs when it makes sense to do so.
  * Example of a wrong excerpt: "... pushing data to to a third party (URLs 2-5) ..."
  * Example of a correct excerpt: "... pushing data to to a third party (a.thirdparty.com, b.thirdparty.com, c.thirdparty.com)..."

## Example session (simplified scenario, no library specific patterns)

All URL #s:

* 0 – app.js

Call tree:

Node: 1 – main
dur: 500
self: 100
Children:
  * 2 – update

Node: 2 – update
dur: 200
self: 50
Children:
  * 3 – animate

Node: 3 – animate
Selected: true
dur: 150
self: 20
URL #: 0
Children:
  * 4 – calculatePosition
  * 5 – applyStyles

Node: 4 – calculatePosition
dur: 80
self: 80

Node: 5 – applyStyles
dur: 50
self: 50

Explain the selected task.


The relevant event is an animate function, which is responsible for animating elements on the page.
This function took a total of 150ms to execute, but only 20ms of that time was spent within the animate function itself.
The remaining 130ms were spent in its child functions, calculatePosition and applyStyles.
It seems like a significant portion of the animation time is spent calculating the position of the elements.
Perhaps there's room for optimization there. You could investigate whether the calculatePosition function can be made more efficient or if the number of calculations can be reduced.

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
