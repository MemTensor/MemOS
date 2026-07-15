#!/usr/bin/env node
/**
 * File Permission MCP Server
 *
 * Exposes a `request_file_permission` tool that the agent calls before
 * performing file operations. The tool communicates with the Electron
 * main process via HTTP to show a permission modal and wait for user response.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

const PERMISSION_API_PORT = process.env.PERMISSION_API_PORT || '9226';
const PERMISSION_API_URL = `http://localhost:${PERMISSION_API_PORT}/permission`;

interface FilePermissionInput {
  operation: 'create' | 'delete' | 'rename' | 'move' | 'modify' | 'overwrite';
  filePath?: string;
  filePaths?: string[];
  targetPath?: string;
  contentPreview?: string;
}

const server = new Server(
  { name: 'file-permission', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'request_file_permission',
      description:
        'Request user permission before performing file operations (create, delete, rename, move, modify, overwrite). Always call this tool BEFORE executing any file modification. Returns "allowed" or "denied".',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['create', 'delete', 'rename', 'move', 'modify', 'overwrite'],
            description: 'The type of file operation to perform',
          },
          filePath: {
            type: 'string',
            description: 'Absolute path to the file being operated on',
          },
          filePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of absolute paths for batch operations (e.g., deleting multiple files)',
          },
          targetPath: {
            type: 'string',
            description: 'Target path for rename/move operations',
          },
          contentPreview: {
            type: 'string',
            description: 'Preview of file content for create/modify operations (first ~500 chars)',
          },
        },
        required: ['operation'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  if (request.params.name !== 'request_file_permission') {
    return {
      content: [{ type: 'text', text: `Error: Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const args = request.params.arguments as FilePermissionInput;
  const { operation, filePath, filePaths, targetPath, contentPreview } = args;

  // Validate required fields
  if (!operation || (!filePath && (!filePaths || filePaths.length === 0))) {
    return {
      content: [{ type: 'text', text: 'Error: operation and either filePath or filePaths are required' }],
      isError: true,
    };
  }

  try {
    // Call Electron main process HTTP endpoint
    const response = await fetch(PERMISSION_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation,
        filePath,
        filePaths,
        targetPath,
        contentPreview: contentPreview?.substring(0, 500), // Truncate preview
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        content: [{ type: 'text', text: `Error: Permission API returned ${response.status}: ${errorText}` }],
        isError: true,
      };
    }

    const result = (await response.json()) as { allowed: boolean };
    return {
      content: [{ type: 'text', text: result.allowed ? 'allowed' : 'denied' }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: Failed to request permission: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start the MCP server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('File Permission MCP Server started');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
