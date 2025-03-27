#!/usr/bin/env node

import { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as shellParseArgs } from 'shell-quote';
import { findActualExecutable } from 'spawn-rx';
import { 
  ClientRequest, 
  ClientNotification,
  ListResourcesResultSchema, 
  ListPromptsResultSchema, 
  ListToolsResultSchema,
  ReadResourceResultSchema,
  GetPromptResultSchema,
  CompatibilityCallToolResultSchema,
  Resource,
  ResourceTemplate,
  ListResourceTemplatesResultSchema,
  CreateMessageResult,
  CreateMessageRequestSchema,
  ProgressNotificationSchema,
  ResourceUpdatedNotificationSchema,
  LoggingMessageNotificationSchema,
  LoggingLevel,
  LoggingLevelSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { z } from 'zod';
import ora from 'ora';
import { table } from 'table';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
// Package version
const packageJson = { version: '0.1.0' };

// Configuration
const DEFAULT_REQUEST_TIMEOUT = 10000;

// Initialize CLI
const program = new Command();
program.name('mcp-inspector-cli')
  .description('CLI version of the MCP Inspector for debugging MCP servers')
  .version(packageJson.version);

// Utility for readable JSON output
function formatJSON(obj: unknown, colorize = true): string {
  const formatted = JSON.stringify(obj, null, 2);
  if (!colorize) return formatted;
  
  try {
    // Use a simple colorization of JSON
    return formatted
      .replace(/"([^"]+)":/g, chalk.blue('"$1":'))
      .replace(/"([^"]+)"/g, chalk.green('"$1"'))
      .replace(/\b(true|false)\b/g, chalk.yellow('$1'))
      .replace(/\b(\d+)\b/g, chalk.yellow('$1'));
  } catch {
    return formatted;
  }
}

// Utility to escape Unicode for better terminal display
function escapeUnicode(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_key: string, value) => {
      if (typeof value === 'string') {
        // Replace non-ASCII characters with their Unicode escape sequences
        return value.replace(/[^\0-\x7F]/g, (char) => {
          return '\\u' + ('0000' + char.charCodeAt(0).toString(16)).slice(-4);
        });
      }
      return value;
    },
    2,
  );
}

// Main class for the MCP Inspector CLI
class MCPInspectorCLI {
  private client: Client | null = null;
  private notificationCount = 0;
  private spinner = ora();
  private serverCapabilities: any = null;
  private pendingSampleRequests: Array<{
    id: number;
    request: any;
    resolve: (result: CreateMessageResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private nextRequestId = 0;
  private logLevel: LoggingLevel = 'debug';
  private roots: any[] = [];

  constructor(private requestTimeout = DEFAULT_REQUEST_TIMEOUT) {}

  async connect(transportType: 'stdio' | 'sse', options: any): Promise<void> {
    this.spinner.start('Connecting to MCP server...');

    try {
      const client = new Client(
        {
          name: 'mcp-inspector-cli',
          version: packageJson.version,
        },
        {
          capabilities: {
            sampling: {},
            roots: {
              listChanged: true,
            },
          },
        }
      );

      let transport;
      
      if (transportType === 'stdio') {
        // Parse command and arguments
        const command = options.command;
        const origArgs = shellParseArgs(options.args || '') as string[];
        const env = { 
          ...process.env, 
          ...getDefaultEnvironment(), 
          ...(options.env ? JSON.parse(options.env) : {}) 
        };

        // Find the actual executable
        const { cmd, args } = findActualExecutable(command, origArgs);
        
        this.spinner.text = `Starting MCP server: ${cmd} ${args.join(' ')}`;
        
        // Create STDIO transport
        transport = new StdioClientTransport({
          command: cmd,
          args,
          env,
          stderr: 'pipe',
        });

        transport.stderr?.on('data', (chunk) => {
          console.error(chalk.red(`[stderr] ${chunk.toString()}`));
        });
      } else {
        // Create SSE transport
        const url = new URL(options.url);
        const headers: HeadersInit = {
          Accept: 'text/event-stream',
        };
        
        if (options.bearerToken) {
          headers['Authorization'] = `Bearer ${options.bearerToken}`;
        }
        
        this.spinner.text = `Connecting to SSE URL: ${url.toString()}`;
        
        transport = new SSEClientTransport(url, {
          eventSourceInit: {
            fetch: (url, init) => fetch(url, { ...init, headers }),
          },
          requestInit: {
            headers,
          },
        });
      }

      // Set up notification handlers
      client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
        this.handleNotification(notification);
      });

      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
        this.handleNotification(notification);
      });

      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        this.handleNotification(notification);
      });
      
      // Handle pending sample requests
      client.setRequestHandler(
        CreateMessageRequestSchema,
        (request) => {
          return new Promise((resolve, reject) => {
            const id = this.nextRequestId++;
            this.pendingSampleRequests.push({
              id,
              request,
              resolve,
              reject,
            });
            
            this.spinner.stop();
            console.log(chalk.yellow('\n[Sampling Request]'), 'Server is requesting a response:');
            console.log(formatJSON(request));
            
            this.promptForSampling(id);
          });
        }
      );

      // Handle root listing
      client.setRequestHandler(
        ListRootsRequestSchema,
        async () => {
          return { roots: this.roots };
        }
      );

      // Connect to the server
      await client.connect(transport);
      this.serverCapabilities = client.getServerCapabilities();
      this.client = client;
      
      this.spinner.succeed('Connected to MCP server');
      
      // Print server capabilities
      console.log('\nServer Capabilities:');
      console.log(formatJSON(this.serverCapabilities));
      
    } catch (error) {
      this.spinner.fail(`Failed to connect: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async makeRequest<T extends z.ZodType>(
    request: ClientRequest,
    schema: T,
    options: { signal?: AbortSignal; suppressOutput?: boolean } = {}
  ): Promise<z.output<T>> {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }

    if (!options.suppressOutput) {
      this.spinner.start('Sending request...');
      console.log(chalk.blue('\n[Request]'), formatJSON(request, false));
    }

    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort('Request timed out');
      }, this.requestTimeout);

      const response = await this.client.request(request, schema, {
        signal: options.signal ?? abortController.signal,
      });

      clearTimeout(timeoutId);
      
      if (!options.suppressOutput) {
        this.spinner.succeed('Request successful');
        console.log(chalk.green('\n[Response]'), formatJSON(response));
      }
      
      return response;
    } catch (e) {
      const errorString = e instanceof Error ? e.message : String(e);
      if (!options.suppressOutput) {
        this.spinner.fail(`Request failed: ${errorString}`);
      }
      throw e;
    }
  }

  async sendNotification(notification: ClientNotification): Promise<void> {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }

    this.spinner.start('Sending notification...');
    console.log(chalk.blue('\n[Notification]'), formatJSON(notification, false));

    try {
      await this.client.notification(notification);
      this.spinner.succeed('Notification sent');
    } catch (e) {
      const errorString = e instanceof Error ? e.message : String(e);
      this.spinner.fail(`Notification failed: ${errorString}`);
      throw e;
    }
  }

  private handleNotification(notification: any): void {
    this.notificationCount++;
    console.log(
      chalk.magenta(`\n[Server Notification #${this.notificationCount}]`),
      formatJSON(notification)
    );
  }

  private async promptForSampling(id: number): Promise<void> {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'How would you like to handle this sampling request?',
        choices: [
          { name: 'Provide a simple response', value: 'simple' },
          { name: 'Provide a custom response', value: 'custom' },
          { name: 'Reject the request', value: 'reject' },
        ],
      },
    ]);

    if (answers.action === 'reject') {
      const request = this.pendingSampleRequests.find((r) => r.id === id);
      if (request) {
        request.reject(new Error('Sampling request rejected by user'));
        this.pendingSampleRequests = this.pendingSampleRequests.filter((r) => r.id !== id);
        console.log(chalk.yellow('Sampling request rejected'));
      }
      return;
    }

    let result: CreateMessageResult;
    
    if (answers.action === 'simple') {
      // Provide a simple stub response
      result = {
        model: 'stub-model',
        stopReason: 'endTurn',
        role: 'assistant',
        content: {
          type: 'text',
          text: 'This is a stub response from MCP Inspector CLI.',
        },
      };
    } else {
      // Get custom response
      const { customResponse } = await inquirer.prompt([
        {
          type: 'editor',
          name: 'customResponse',
          message: 'Enter your custom response:',
          default: 'This is a custom response from MCP Inspector CLI.',
        },
      ]);

      result = {
        model: 'custom-model',
        stopReason: 'endTurn',
        role: 'assistant',
        content: {
          type: 'text',
          text: customResponse,
        },
      };
    }

    // Resolve the request
    const request = this.pendingSampleRequests.find((r) => r.id === id);
    if (request) {
      request.resolve(result);
      this.pendingSampleRequests = this.pendingSampleRequests.filter((r) => r.id !== id);
      console.log(chalk.green('Sampling response sent'));
    }
  }

  async listResources(options: { cursor?: string } = {}): Promise<void> {
    try {
      const response = await this.makeRequest(
        {
          method: 'resources/list',
          params: options.cursor ? { cursor: options.cursor } : {},
        },
        ListResourcesResultSchema
      );

      if (response.resources && response.resources.length > 0) {
        // Print resources in a table format
        const data = [
          ['Name', 'URI'],
          ...response.resources.map((resource: Resource) => [
            resource.name || '(unnamed)',
            resource.uri,
          ]),
        ];
        
        console.log(chalk.cyan('\nResources:'));
        console.log(table(data));
        
        if (response.nextCursor) {
          console.log(chalk.yellow(`\nMore resources available. Use --cursor "${response.nextCursor}" to fetch the next page.`));
        }
      } else {
        console.log(chalk.yellow('\nNo resources found.'));
      }
    } catch (error) {
      console.error(chalk.red('\nFailed to list resources:'), error);
    }
  }

  async listResourceTemplates(options: { cursor?: string } = {}): Promise<void> {
    try {
      const response = await this.makeRequest(
        {
          method: 'resources/templates/list',
          params: options.cursor ? { cursor: options.cursor } : {},
        },
        ListResourceTemplatesResultSchema
      );

      if (response.resourceTemplates && response.resourceTemplates.length > 0) {
        // Print resource templates in a table format
        const data = [
          ['Name', 'URI Template', 'Description'],
          ...response.resourceTemplates.map((template: ResourceTemplate) => [
            template.name || '(unnamed)',
            template.uriTemplate,
            template.description || '',
          ]),
        ];
        
        console.log(chalk.cyan('\nResource Templates:'));
        console.log(table(data));
        
        if (response.nextCursor) {
          console.log(chalk.yellow(`\nMore templates available. Use --cursor "${response.nextCursor}" to fetch the next page.`));
        }
      } else {
        console.log(chalk.yellow('\nNo resource templates found.'));
      }
    } catch (error) {
      console.error(chalk.red('\nFailed to list resource templates:'), error);
    }
  }

  async readResource(uri: string): Promise<void> {
    try {
      const response = await this.makeRequest(
        {
          method: 'resources/read',
          params: { uri },
        },
        ReadResourceResultSchema
      );

      console.log(chalk.cyan(`\nResource Content (${uri}):`));
      if (typeof response === 'object') {
        console.log(formatJSON(response));
      } else {
        console.log(response);
      }
    } catch (error) {
      console.error(chalk.red('\nFailed to read resource:'), error);
    }
  }

  async subscribeToResource(uri: string): Promise<void> {
    try {
      await this.makeRequest(
        {
          method: 'resources/subscribe',
          params: { uri },
        },
        z.object({})
      );
      
      console.log(chalk.green(`\nSubscribed to resource: ${uri}`));
      console.log(chalk.gray('You will now receive notifications when this resource changes.'));
    } catch (error) {
      console.error(chalk.red('\nFailed to subscribe to resource:'), error);
    }
  }

  async unsubscribeFromResource(uri: string): Promise<void> {
    try {
      await this.makeRequest(
        {
          method: 'resources/unsubscribe',
          params: { uri },
        },
        z.object({})
      );
      
      console.log(chalk.green(`\nUnsubscribed from resource: ${uri}`));
    } catch (error) {
      console.error(chalk.red('\nFailed to unsubscribe from resource:'), error);
    }
  }

  async useResourceTemplate(templateName: string): Promise<void> {
    try {
      // First list templates to find the one we need
      const response = await this.makeRequest(
        { method: 'resources/templates/list', params: {} },
        ListResourceTemplatesResultSchema,
        { suppressOutput: true }
      );
      
      const template = response.resourceTemplates?.find(t => t.name === templateName);
      
      if (!template) {
        console.error(chalk.red(`\nTemplate "${templateName}" not found.`));
        return;
      }
      
      console.log(chalk.cyan(`\nTemplate: ${template.name}`));
      console.log(chalk.gray(`URI Template: ${template.uriTemplate}`));
      if (template.description) {
        console.log(chalk.gray(`Description: ${template.description}`));
      }
      
      // Extract parameters from the template
      const params = template.uriTemplate.match(/{([^}]+)}/g)?.map(p => p.slice(1, -1)) || [];
      
      if (params.length === 0) {
        console.log(chalk.yellow('\nThis template has no parameters.'));
        
        // Prompt to read the resource directly
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: 'Would you like to read this resource?',
            default: true,
          },
        ]);
        
        if (confirm) {
          await this.readResource(template.uriTemplate);
        }
        
        return;
      }
      
      // Prompt for each parameter
      const values: Record<string, string> = {};
      
      for (const param of params) {
        const { value } = await inquirer.prompt([
          {
            type: 'input',
            name: 'value',
            message: `Enter value for ${param}:`,
          },
        ]);
        
        values[param] = value;
      }
      
      // Fill in the template
      const uri = template.uriTemplate.replace(/{([^}]+)}/g, (_, key) => values[key] || `{${key}}`);
      
      console.log(chalk.blue(`\nFilled URI: ${uri}`));
      
      // Prompt to read the resource
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Would you like to read this resource?',
          default: true,
        },
      ]);
      
      if (confirm) {
        await this.readResource(uri);
      }
      
    } catch (error) {
      console.error(chalk.red('\nFailed to use resource template:'), error);
    }
  }

  async listPrompts(options: { cursor?: string } = {}): Promise<void> {
    try {
      const response = await this.makeRequest(
        {
          method: 'prompts/list',
          params: options.cursor ? { cursor: options.cursor } : {},
        },
        ListPromptsResultSchema
      );

      if (response.prompts && response.prompts.length > 0) {
        // Print prompts in a table format
        const data = [
          ['Name', 'Description', 'Arguments'],
          ...response.prompts.map((prompt: any) => [
            prompt.name || '(unnamed)',
            prompt.description || '',
            prompt.arguments ? `${prompt.arguments.length} arg(s)` : 'None',
          ]),
        ];
        
        console.log(chalk.cyan('\nPrompts:'));
        console.log(table(data));
        
        if (response.nextCursor) {
          console.log(chalk.yellow(`\nMore prompts available. Use --cursor "${response.nextCursor}" to fetch the next page.`));
        }
      } else {
        console.log(chalk.yellow('\nNo prompts found.'));
      }
    } catch (error) {
      console.error(chalk.red('\nFailed to list prompts:'), error);
    }
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<void> {
    try {
      // First, get prompt metadata to know what arguments are needed
      const listResponse = await this.makeRequest(
        { method: 'prompts/list', params: {} },
        ListPromptsResultSchema,
        { suppressOutput: true }
      );
      
      const promptInfo = listResponse.prompts?.find(p => p.name === name);
      
      if (!promptInfo) {
        console.error(chalk.red(`\nPrompt "${name}" not found.`));
        return;
      }
      
      // If there are arguments, prompt for any missing ones
      if (promptInfo.arguments && promptInfo.arguments.length > 0) {
        for (const arg of promptInfo.arguments) {
          if (args[arg.name] === undefined) {
            const { value } = await inquirer.prompt([
              {
                type: 'input',
                name: 'value',
                message: `Enter value for ${arg.name}${arg.required ? ' (required)' : ''}:`,
                default: '',
              },
            ]);
            
            if (value) {
              args[arg.name] = value;
            }
          }
        }
      }
      
      // Get the prompt
      const response = await this.makeRequest(
        {
          method: 'prompts/get',
          params: { name, arguments: args },
        },
        GetPromptResultSchema
      );

      console.log(chalk.cyan(`\nPrompt Content (${name}):`));
      console.log(response);
    } catch (error) {
      console.error(chalk.red('\nFailed to get prompt:'), error);
    }
  }

  async listTools(options: { cursor?: string } = {}): Promise<void> {
    try {
      const response = await this.makeRequest(
        {
          method: 'tools/list',
          params: options.cursor ? { cursor: options.cursor } : {},
        },
        ListToolsResultSchema
      );

      if (response.tools && response.tools.length > 0) {
        // Print tools in a table format
        const data = [
          ['Name', 'Description'],
          ...response.tools.map((tool: any) => [
            tool.name || '(unnamed)',
            tool.description || '',
          ]),
        ];
        
        console.log(chalk.cyan('\nTools:'));
        console.log(table(data));
        
        if (response.nextCursor) {
          console.log(chalk.yellow(`\nMore tools available. Use --cursor "${response.nextCursor}" to fetch the next page.`));
        }
      } else {
        console.log(chalk.yellow('\nNo tools found.'));
      }
    } catch (error) {
      console.error(chalk.red('\nFailed to list tools:'), error);
    }
  }

  async callTool(name: string, params: Record<string, unknown> = {}): Promise<void> {
    try {
      // First, get tool metadata
      const listResponse = await this.makeRequest(
        { method: 'tools/list', params: {} },
        ListToolsResultSchema,
        { suppressOutput: true }
      );
      
      const toolInfo = listResponse.tools?.find(t => t.name === name);
      
      if (!toolInfo) {
        console.error(chalk.red(`\nTool "${name}" not found.`));
        return;
      }
      
      // If there's an input schema, prompt for parameters
      if (toolInfo.inputSchema && toolInfo.inputSchema.properties) {
        const schemaProps = toolInfo.inputSchema.properties;
        
        for (const [key, prop] of Object.entries(schemaProps)) {
          if (params[key] !== undefined) continue;
          
          const typedProp = prop as any;
          let promptType = 'input';
          let defaultValue: any = null;
          
          // Determine prompt type based on parameter type
          if (typedProp.type === 'boolean') {
            promptType = 'confirm';
            defaultValue = false;
          } else if (typedProp.type === 'object' || typedProp.type === 'array') {
            promptType = 'editor';
            defaultValue = JSON.stringify(typedProp.type === 'array' ? [] : {}, null, 2);
          } else if (typedProp.type === 'number' || typedProp.type === 'integer') {
            promptType = 'number';
            defaultValue = 0;
          } else {
            defaultValue = '';
          }
          
          const { value } = await inquirer.prompt([
            {
              type: promptType,
              name: 'value',
              message: `Enter ${key}${typedProp.description ? ` (${typedProp.description})` : ''}:`,
              default: defaultValue,
            },
          ]);
          
          // Parse JSON for object/array types
          if (typedProp.type === 'object' || typedProp.type === 'array') {
            try {
              params[key] = JSON.parse(value);
            } catch (e) {
              console.error(chalk.red(`Invalid JSON for parameter ${key}. Using empty ${typedProp.type}.`));
              params[key] = typedProp.type === 'array' ? [] : {};
            }
          } else {
            params[key] = value;
          }
        }
      }
      
      // Call the tool
      const progressToken = Date.now();
      const response = await this.makeRequest(
        {
          method: 'tools/call',
          params: {
            name,
            arguments: params,
            _meta: {
              progressToken,
            },
          },
        },
        CompatibilityCallToolResultSchema
      );

      console.log(chalk.cyan('\nTool Result:'));
      
      // Handle different result formats
      if ('content' in response && Array.isArray(response.content)) {
        for (const item of response.content as any[]) {
          if (item.type === 'text') {
            console.log(item.text);
          } else if (item.type === 'image') {
            console.log(chalk.yellow('[Image data]'));
            
            // Optionally save image to file
            const { saveImage } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'saveImage',
                message: 'Would you like to save this image to a file?',
                default: false,
              },
            ]);
            
            if (saveImage) {
              const { filename } = await inquirer.prompt([
                {
                  type: 'input',
                  name: 'filename',
                  message: 'Enter filename:',
                  default: `image_${Date.now()}.png`,
                },
              ]);
              
              fs.writeFileSync(
                filename, 
                Buffer.from(item.data, 'base64')
              );
              console.log(chalk.green(`Image saved to ${filename}`));
            }
          } else if (item.type === 'resource') {
            console.log(chalk.yellow(`[Resource of type ${item.resource?.mimeType || 'unknown'}]`));
            console.log(formatJSON(item.resource));
          }
        }
      } else if ('toolResult' in response) {
        console.log(formatJSON(response.toolResult));
      } else {
        console.log(formatJSON(response));
      }
    } catch (error) {
      console.error(chalk.red('\nFailed to call tool:'), error);
    }
  }

  async ping(): Promise<void> {
    try {
      await this.makeRequest(
        { method: 'ping' },
        z.object({})
      );
      
      console.log(chalk.green('\nPing successful!'));
    } catch (error) {
      console.error(chalk.red('\nPing failed:'), error);
    }
  }

  async updateRoots(newRoots: { uri: string }[]): Promise<void> {
    try {
      this.roots = newRoots;
      
      await this.sendNotification({ 
        method: 'notifications/roots/list_changed' 
      });
      
      console.log(chalk.green('\nRoots updated successfully.'));
    } catch (error) {
      console.error(chalk.red('\nFailed to update roots:'), error);
    }
  }

  async setLogLevel(level: LoggingLevel): Promise<void> {
    try {
      await this.makeRequest(
        {
          method: 'logging/setLevel',
          params: { level },
        },
        z.object({})
      );
      
      this.logLevel = level;
      console.log(chalk.green(`\nLog level set to ${level}`));
    } catch (error) {
      console.error(chalk.red('\nFailed to set log level:'), error);
    }
  }

  async interactiveMode(): Promise<void> {
    if (!this.client) {
      console.error(chalk.red('Not connected to any MCP server. Connect first.'));
      return;
    }
    
    console.log(chalk.green('\nEntering interactive mode. Type "help" for available commands, "exit" to quit.'));
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.blue('mcp> '),
    });
    
    rl.prompt();
    
    rl.on('line', async (line) => {
      const input = line.trim();
      
      if (input === 'exit' || input === 'quit') {
        console.log(chalk.green('Exiting interactive mode.'));
        rl.close();
        return;
      }
      
      if (input === 'help') {
        const capabilities = this.serverCapabilities;
        
        console.log(chalk.cyan('\nAvailable Commands:'));
        console.log(chalk.gray('General:'));
        console.log('  help                     Show this help message');
        console.log('  exit, quit               Exit interactive mode');
        console.log('  capabilities             Show server capabilities');
        console.log('  ping                     Ping the server');
        
        if (capabilities?.resources) {
          console.log(chalk.gray('\nResources:'));
          console.log('  resources               List available resources');
          console.log('  read <uri>              Read a specific resource');
          console.log('  templates               List resource templates');
          console.log('  template <name>         Use a resource template');
          
          if (capabilities.resources.subscribe) {
            console.log('  subscribe <uri>         Subscribe to resource updates');
            console.log('  unsubscribe <uri>       Unsubscribe from resource updates');
          }
        }
        
        if (capabilities?.prompts) {
          console.log(chalk.gray('\nPrompts:'));
          console.log('  prompts                 List available prompts');
          console.log('  prompt <name>           Get a specific prompt');
        }
        
        if (capabilities?.tools) {
          console.log(chalk.gray('\nTools:'));
          console.log('  tools                   List available tools');
          console.log('  tool <name>             Call a specific tool');
        }
        
        if (capabilities?.roots) {
          console.log(chalk.gray('\nRoots:'));
          console.log('  roots                   List current roots');
          console.log('  roots add <uri>         Add a root directory');
          console.log('  roots remove <index>    Remove a root directory');
          console.log('  roots update            Apply root changes');
        }
        
        if (capabilities?.logging) {
          console.log(chalk.gray('\nLogging:'));
          console.log('  log level               Show current log level');
          console.log('  log level <level>       Set log level (debug, info, warn, error)');
        }
        
        rl.prompt();
        return;
      }
      
      if (input === 'capabilities') {
        console.log(chalk.cyan('\nServer Capabilities:'));
        console.log(formatJSON(this.serverCapabilities));
        rl.prompt();
        return;
      }
      
      if (input === 'ping') {
        await this.ping();
        rl.prompt();
        return;
      }
      
      if (input === 'resources') {
        await this.listResources();
        rl.prompt();
        return;
      }
      
      if (input === 'templates') {
        await this.listResourceTemplates();
        rl.prompt();
        return;
      }
      
      if (input.startsWith('template ')) {
        const templateName = input.substring('template '.length).trim();
        await this.useResourceTemplate(templateName);
        rl.prompt();
        return;
      }
      
      if (input.startsWith('read ')) {
        const uri = input.substring('read '.length).trim();
        await this.readResource(uri);
        rl.prompt();
        return;
      }
      
      if (input.startsWith('subscribe ')) {
        const uri = input.substring('subscribe '.length).trim();
        await this.subscribeToResource(uri);
        rl.prompt();
        return;
      }
      
      if (input.startsWith('unsubscribe ')) {
        const uri = input.substring('unsubscribe '.length).trim();
        await this.unsubscribeFromResource(uri);
        rl.prompt();
        return;
      }
      
      if (input === 'prompts') {
        await this.listPrompts();
        rl.prompt();
        return;
      }
      
      if (input.startsWith('prompt ')) {
        const promptName = input.substring('prompt '.length).trim();
        await this.getPrompt(promptName);
        rl.prompt();
        return;
      }
      
      if (input === 'tools') {
        await this.listTools();
        rl.prompt();
        return;
      }
      
      if (input.startsWith('tool ')) {
        const toolName = input.substring('tool '.length).trim();
        await this.callTool(toolName);
        rl.prompt();
        return;
      }
      
      if (input === 'roots') {
        console.log(chalk.cyan('\nCurrent Roots:'));
        if (this.roots.length === 0) {
          console.log(chalk.yellow('No roots defined.'));
        } else {
          this.roots.forEach((root, i) => {
            console.log(`  ${i}: ${root.uri}`);
          });
        }
        rl.prompt();
        return;
      }
      
      if (input.startsWith('roots add ')) {
        const uri = input.substring('roots add '.length).trim();
        this.roots.push({ uri });
        console.log(chalk.green(`Added root: ${uri}`));
        console.log(chalk.gray('Remember to apply changes with "roots update"'));
        rl.prompt();
        return;
      }
      
      if (input.startsWith('roots remove ')) {
        const indexStr = input.substring('roots remove '.length).trim();
        const index = parseInt(indexStr, 10);
        
        if (isNaN(index) || index < 0 || index >= this.roots.length) {
          console.error(chalk.red(`Invalid index. Use 0-${this.roots.length - 1}`));
        } else {
          const removed = this.roots.splice(index, 1)[0];
          console.log(chalk.green(`Removed root: ${removed.uri}`));
          console.log(chalk.gray('Remember to apply changes with "roots update"'));
        }
        rl.prompt();
        return;
      }
      
      if (input === 'roots update') {
        await this.updateRoots(this.roots);
        rl.prompt();
        return;
      }
      
      if (input === 'log level') {
        console.log(chalk.cyan(`\nCurrent log level: ${this.logLevel}`));
        rl.prompt();
        return;
      }
      
      if (input.startsWith('log level ')) {
        const levelStr = input.substring('log level '.length).trim() as LoggingLevel;
        
        if (!Object.values(LoggingLevelSchema.enum).includes(levelStr)) {
          console.error(chalk.red(`Invalid log level. Use: ${Object.values(LoggingLevelSchema.enum).join(', ')}`));
        } else {
          await this.setLogLevel(levelStr);
        }
        rl.prompt();
        return;
      }
      
      console.log(chalk.red(`Unknown command: ${input}`));
      console.log('Type "help" for available commands.');
      rl.prompt();
    });
    
    rl.on('close', () => {
      console.log(chalk.gray('\nExiting interactive mode.'));
    });
  }
}

// Configure connection options
program
  .command('connect')
  .description('Connect to an MCP server')
  .option('-t, --transport <type>', 'Transport type (stdio or sse)', 'stdio')
  .option('-c, --command <command>', 'Command to run (for stdio transport)', 'node')
  .option('-a, --args <args>', 'Arguments for the command (for stdio transport)', '')
  .option('-u, --url <url>', 'URL of the MCP server (for sse transport)', 'http://localhost:3000/sse')
  .option('-b, --bearer-token <token>', 'Bearer token for authentication (for sse transport)')
  .option('-e, --env <json>', 'Environment variables as JSON (for stdio transport)')
  .option('-i, --interactive', 'Start in interactive mode after connecting', false)
  .action(async (options: { transport: string; command: string; args: string; url: string; bearerToken?: string; env?: string; interactive: boolean }) => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect(options.transport as 'stdio' | 'sse', {
        command: options.command,
        args: options.args,
        url: options.url,
        bearerToken: options.bearerToken,
        env: options.env,
      });
      
      if (options.interactive) {
        await cli.interactiveMode();
      }
    } catch (error) {
      console.error(chalk.red('Failed to connect:'), error);
      process.exit(1);
    }
  });

// Resources commands
const resourcesCommand = program
  .command('resources')
  .description('Work with MCP resources');

resourcesCommand
  .command('list')
  .description('List available resources')
  .option('--cursor <cursor>', 'Cursor for pagination')
  .action(async (options: { cursor?: string }) => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.listResources(options);
    } catch (error) {
      console.error(chalk.red('Failed to list resources:'), error);
      process.exit(1);
    }
  });

resourcesCommand
  .command('templates')
  .description('List available resource templates')
  .option('--cursor <cursor>', 'Cursor for pagination')
  .action(async (options: { cursor?: string }) => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.listResourceTemplates(options);
    } catch (error) {
      console.error(chalk.red('Failed to list resource templates:'), error);
      process.exit(1);
    }
  });

resourcesCommand
  .command('read <uri>')
  .description('Read a specific resource')
  .action(async (uri: string) => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.readResource(uri);
    } catch (error) {
      console.error(chalk.red('Failed to read resource:'), error);
      process.exit(1);
    }
  });

resourcesCommand
  .command('subscribe <uri>')
  .description('Subscribe to resource updates')
  .action(async (uri: string) => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.subscribeToResource(uri);
    } catch (error) {
      console.error(chalk.red('Failed to subscribe to resource:'), error);
      process.exit(1);
    }
  });

resourcesCommand
  .command('unsubscribe <uri>')
  .description('Unsubscribe from resource updates')
  .action(async (uri: string) => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.unsubscribeFromResource(uri);
    } catch (error) {
      console.error(chalk.red('Failed to unsubscribe from resource:'), error);
      process.exit(1);
    }
  });

// Prompts commands
const promptsCommand = program
  .command('prompts')
  .description('Work with MCP prompts');

promptsCommand
  .command('list')
  .description('List available prompts')
  .option('--cursor <cursor>', 'Cursor for pagination')
  .action(async (options: { cursor?: string }) => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.listPrompts(options);
    } catch (error) {
      console.error(chalk.red('Failed to list prompts:'), error);
      process.exit(1);
    }
  });

promptsCommand
  .command('get <name>')
  .description('Get a specific prompt')
  .option('-a, --arg <arg...>', 'Prompt arguments in format name=value')
  .action(async (name: string, options: { arg?: string[] }) => {
    const cli = new MCPInspectorCLI();
    
    // Parse arguments
    const args: Record<string, string> = {};
    if (options.arg) {
      for (const arg of options.arg) {
        const [key, value] = arg.split('=');
        if (key && value) {
          args[key] = value;
        }
      }
    }
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.getPrompt(name, args);
    } catch (error) {
      console.error(chalk.red('Failed to get prompt:'), error);
      process.exit(1);
    }
  });

// Tools commands
const toolsCommand = program
  .command('tools')
  .description('Work with MCP tools');

toolsCommand
  .command('list')
  .description('List available tools')
  .option('--cursor <cursor>', 'Cursor for pagination')
  .action(async (options: { cursor?: string }) => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.listTools(options);
    } catch (error) {
      console.error(chalk.red('Failed to list tools:'), error);
      process.exit(1);
    }
  });

toolsCommand
  .command('call <name>')
  .description('Call a specific tool')
  .option('-p, --param <param...>', 'Tool parameters in format name=value')
  .option('-j, --json-param <param...>', 'JSON tool parameters in format name=\'{"key":"value"}\'')
  .action(async (name: string, options: { param?: string[]; jsonParam?: string[] }) => {
    const cli = new MCPInspectorCLI();
    
    // Parse parameters
    const params: Record<string, unknown> = {};
    
    if (options.param) {
      for (const param of options.param) {
        const [key, value] = param.split('=');
        if (key) {
          params[key] = value || '';
        }
      }
    }
    
    if (options.jsonParam) {
      for (const param of options.jsonParam) {
        const [key, jsonValue] = param.split('=');
        if (key && jsonValue) {
          try {
            params[key] = JSON.parse(jsonValue);
          } catch (e) {
            console.error(chalk.red(`Invalid JSON for parameter ${key}. Skipping.`));
          }
        }
      }
    }
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.callTool(name, params);
    } catch (error) {
      console.error(chalk.red('Failed to call tool:'), error);
      process.exit(1);
    }
  });

// Ping command
program
  .command('ping')
  .description('Ping the MCP server')
  .action(async () => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect('stdio', { command: 'node' });
      await cli.ping();
    } catch (error) {
      console.error(chalk.red('Failed to ping:'), error);
      process.exit(1);
    }
  });

// Interactive mode command
program
  .command('interactive')
  .alias('i')
  .description('Start the CLI in interactive mode')
  .option('-t, --transport <type>', 'Transport type (stdio or sse)', 'stdio')
  .option('-c, --command <command>', 'Command to run (for stdio transport)', 'node')
  .option('-a, --args <args>', 'Arguments for the command (for stdio transport)', '')
  .option('-u, --url <url>', 'URL of the MCP server (for sse transport)', 'http://localhost:3000/sse')
  .option('-b, --bearer-token <token>', 'Bearer token for authentication (for sse transport)')
  .option('-e, --env <json>', 'Environment variables as JSON (for stdio transport)')
  .action(async (options: { transport: string; command: string; args: string; url: string; bearerToken?: string; env?: string; }) => {
    const cli = new MCPInspectorCLI();
    
    try {
      await cli.connect(options.transport as 'stdio' | 'sse', {
        command: options.command,
        args: options.args,
        url: options.url,
        bearerToken: options.bearerToken,
        env: options.env,
      });
      
      await cli.interactiveMode();
    } catch (error) {
      console.error(chalk.red('Failed to start interactive mode:'), error);
      process.exit(1);
    }
  });

// Parse args and run
program.parse();
