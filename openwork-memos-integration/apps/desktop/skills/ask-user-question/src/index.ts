#!/usr/bin/env node
/**
 * AskUserQuestion MCP Server
 *
 * Exposes an `AskUserQuestion` tool that the agent calls to ask users
 * questions via the UI. Communicates with Electron main process via HTTP.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

const QUESTION_API_PORT = process.env.QUESTION_API_PORT || '9227';
const QUESTION_API_URL = `http://localhost:${QUESTION_API_PORT}/question`;

interface QuestionOption {
  label: string;
  description?: string;
}

interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options?: QuestionOption[];
    multiSelect?: boolean;
  }>;
}

const server = new Server(
  { name: 'ask-user-question', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'AskUserQuestion',
      description:
        'Ask the user a question and wait for their response. Use this for clarifications, confirmations before sensitive actions, or when you need user input to proceed. Returns the user\'s selected option(s) or custom text response.',
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'Array of questions to ask (typically just one)',
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The question to ask the user',
                },
                header: {
                  type: 'string',
                  description: 'Short header/category for the question (max 12 chars)',
                },
                options: {
                  type: 'array',
                  description: 'Available choices for the user (2-4 options)',
                  items: {
                    type: 'object',
                    properties: {
                      label: {
                        type: 'string',
                        description: 'Display text for this option',
                      },
                      description: {
                        type: 'string',
                        description: 'Explanation of what this option means',
                      },
                    },
                    required: ['label'],
                  },
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'Allow selecting multiple options',
                  default: false,
                },
              },
              required: ['question'],
            },
            minItems: 1,
            maxItems: 4,
          },
        },
        required: ['questions'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  if (request.params.name !== 'AskUserQuestion') {
    return {
      content: [{ type: 'text', text: `Error: Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const args = request.params.arguments as AskUserQuestionInput;
  const { questions } = args;

  // Validate required fields
  if (!questions || questions.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: At least one question is required' }],
      isError: true,
    };
  }

  const question = questions[0];
  if (!question.question) {
    return {
      content: [{ type: 'text', text: 'Error: Question text is required' }],
      isError: true,
    };
  }

  try {
    // Call Electron main process HTTP endpoint
    const response = await fetch(QUESTION_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question.question,
        header: question.header,
        options: question.options,
        multiSelect: question.multiSelect,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        content: [{ type: 'text', text: `Error: Question API returned ${response.status}: ${errorText}` }],
        isError: true,
      };
    }

    const result = (await response.json()) as {
      answered: boolean;
      selectedOptions?: string[];
      customText?: string;
      denied?: boolean;
    };

    if (result.denied) {
      return {
        content: [{ type: 'text', text: 'User declined to answer the question.' }],
      };
    }

    // Format response for the agent
    if (result.selectedOptions && result.selectedOptions.length > 0) {
      return {
        content: [{ type: 'text', text: `User selected: ${result.selectedOptions.join(', ')}` }],
      };
    }

    if (result.customText) {
      return {
        content: [{ type: 'text', text: `User responded: ${result.customText}` }],
      };
    }

    return {
      content: [{ type: 'text', text: 'User provided no response.' }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: Failed to ask question: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start the MCP server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AskUserQuestion MCP Server started');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
