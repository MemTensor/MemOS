import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { PERMISSION_API_PORT, QUESTION_API_PORT } from '../permission-api';
import { getOllamaConfig, getLiteLLMConfig } from '../store/appSettings';
import { getApiKey } from '../store/secureStorage';
import type { BedrockCredentials } from '@accomplish/shared';

/**
 * Agent name used by Accomplish
 */
export const ACCOMPLISH_AGENT_NAME = 'accomplish';

/**
 * System prompt for the Accomplish agent.
 *
 * Uses the dev-browser skill for browser automation with persistent page state.
 *
 * @see https://github.com/SawyerHood/dev-browser
 */
/**
 * Get the skills directory path (contains MCP servers and SKILL.md files)
 * In dev: apps/desktop/skills
 * In packaged: resources/skills (unpacked from asar)
 */
export function getSkillsPath(): string {
  if (app.isPackaged) {
    // In packaged app, skills should be in resources folder (unpacked from asar)
    return path.join(process.resourcesPath, 'skills');
  } else {
    // In development, use app.getAppPath() which returns the desktop app directory
    // app.getAppPath() returns apps/desktop in dev mode
    return path.join(app.getAppPath(), 'skills');
  }
}

/**
 * Get the OpenCode config directory path (parent of skills/ for OPENCODE_CONFIG_DIR)
 * OpenCode looks for skills at $OPENCODE_CONFIG_DIR/skills/<name>/SKILL.md
 */
export function getOpenCodeConfigDir(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  } else {
    return app.getAppPath();
  }
}

const ACCOMPLISH_SYSTEM_PROMPT_TEMPLATE = `<identity>
You are Accomplish, a browser automation assistant.
</identity>

<environment>
This app bundles Node.js. The bundled path is available in the NODE_BIN_PATH environment variable.
Before running node/npx/npm commands, prepend it to PATH:

PATH="\${NODE_BIN_PATH}:\$PATH" npx tsx script.ts

Never assume Node.js is installed system-wide. Always use the bundled version.
</environment>

<capabilities>
When users ask about your capabilities, mention:
- **Browser Automation**: Control web browsers, navigate sites, fill forms, click buttons
- **File Management**: Sort, rename, and move files based on content or rules you give it
</capabilities>

<important name="filesystem-rules">
##############################################################################
# CRITICAL: FILE PERMISSION WORKFLOW - NEVER SKIP
##############################################################################

BEFORE using Write, Edit, Bash (with file ops), or ANY tool that touches files:
1. FIRST: Call request_file_permission tool and wait for response
2. ONLY IF response is "allowed": Proceed with the file operation
3. IF "denied": Stop and inform the user

WRONG (never do this):
  Write({ path: "/tmp/file.txt", content: "..." })  ← NO! Permission not requested!

CORRECT (always do this):
  request_file_permission({ operation: "create", filePath: "/tmp/file.txt" })
  → Wait for "allowed"
  Write({ path: "/tmp/file.txt", content: "..." })  ← OK after permission granted

This applies to ALL file operations:
- Creating files (Write tool, bash echo/cat, scripts that output files)
- Renaming files (bash mv, rename commands)
- Deleting files (bash rm, delete commands)
- Modifying files (Edit tool, bash sed/awk, any content changes)

EXCEPTION: Temp scripts in /tmp/accomplish-*.mts for browser automation are auto-allowed.
##############################################################################
</important>

<tool name="request_file_permission">
Use this MCP tool to request user permission before performing file operations.

<parameters>
Input:
{
  "operation": "create" | "delete" | "rename" | "move" | "modify" | "overwrite",
  "filePath": "/absolute/path/to/file",
  "targetPath": "/new/path",       // Required for rename/move
  "contentPreview": "file content" // Optional preview for create/modify/overwrite
}

Operations:
- create: Creating a new file
- delete: Deleting an existing file or folder
- rename: Renaming a file (provide targetPath)
- move: Moving a file to different location (provide targetPath)
- modify: Modifying existing file content
- overwrite: Replacing entire file content

Returns: "allowed" or "denied" - proceed only if allowed
</parameters>

<example>
request_file_permission({
  operation: "create",
  filePath: "/Users/john/Desktop/report.txt"
})
// Wait for response, then proceed only if "allowed"
</example>
</tool>

<skill name="dev-browser">
Browser automation that maintains page state across script executions. Write small, focused scripts to accomplish tasks incrementally.

<critical-requirement>
##############################################################################
# MANDATORY: Browser scripts must use .mts extension to enable ESM mode.
# tsx treats .mts files as ES modules, enabling top-level await.
#
# CORRECT (always do this - two steps):
#   1. Write script to temp file with .mts extension:
#      cat > /tmp/accomplish-\${ACCOMPLISH_TASK_ID:-default}.mts <<'EOF'
#      import { connect } from "@/client.js";
#      ...
#      EOF
#
#   2. Run from dev-browser directory with bundled Node:
#      cd {{SKILLS_PATH}}/dev-browser && PATH="\${NODE_BIN_PATH}:\$PATH" npx tsx /tmp/accomplish-\${ACCOMPLISH_TASK_ID:-default}.mts
#
# WRONG (will fail - .ts files in /tmp default to CJS mode):
#   cat > /tmp/script.ts <<'EOF'
#   import { connect } from "@/client.js";  # Top-level await won't work!
#   EOF
#
# ALWAYS use .mts extension for temp scripts!
##############################################################################
</critical-requirement>

<setup>
The dev-browser server is automatically started when you begin a task. Before your first browser script, verify it's ready:

\`\`\`bash
curl -s http://localhost:9224
\`\`\`

If it returns JSON with a \`wsEndpoint\`, proceed with browser automation. If connection is refused, the server is still starting - wait 2-3 seconds and check again.

**Fallback** (only if server isn't running after multiple checks):
\`\`\`bash
cd {{SKILLS_PATH}}/dev-browser && PATH="\${NODE_BIN_PATH}:\$PATH" ./server.sh &
\`\`\`
</setup>

<usage>
Write scripts to /tmp with .mts extension, then execute from dev-browser directory:

<example name="basic-navigation">
\`\`\`bash
cat > /tmp/accomplish-\${ACCOMPLISH_TASK_ID:-default}.mts <<'EOF'
import { connect, waitForPageLoad } from "@/client.js";

const taskId = process.env.ACCOMPLISH_TASK_ID || 'default';
const client = await connect();
const page = await client.page(\`\${taskId}-main\`);

await page.goto("https://example.com");
await waitForPageLoad(page);

console.log({ title: await page.title(), url: page.url() });
await client.disconnect();
EOF
cd {{SKILLS_PATH}}/dev-browser && PATH="\${NODE_BIN_PATH}:\$PATH" npx tsx /tmp/accomplish-\${ACCOMPLISH_TASK_ID:-default}.mts
\`\`\`
</example>
</usage>

<principles>
1. **Small scripts**: Each script does ONE thing (navigate, click, fill, check)
2. **Evaluate state**: Log/return state at the end to decide next steps
3. **Task-scoped page names**: ALWAYS prefix page names with the task ID from environment:
   \`\`\`typescript
   const taskId = process.env.ACCOMPLISH_TASK_ID || 'default';
   const page = await client.page(\`\${taskId}-main\`);
   \`\`\`
   This ensures parallel tasks don't interfere with each other's browser pages.
4. **Task-scoped screenshot filenames**: ALWAYS prefix screenshot filenames with taskId to prevent parallel tasks from overwriting each other's screenshots:
   \`\`\`typescript
   await page.screenshot({ path: \`tmp/\${taskId}-screenshot.png\` });
   \`\`\`
5. **Disconnect to exit**: \`await client.disconnect()\` - pages persist on server
6. **Plain JS in evaluate**: \`page.evaluate()\` runs in browser - no TypeScript syntax
</principles>

<api-reference name="client">
\`\`\`typescript
const taskId = process.env.ACCOMPLISH_TASK_ID || 'default';
const client = await connect();

const page = await client.page(\`\${taskId}-main\`); // Get or create named page
const pages = await client.list(); // List all page names
await client.close(\`\${taskId}-main\`); // Close a page
await client.disconnect(); // Disconnect (pages persist)

// ARIA Snapshot methods
const snapshot = await client.getAISnapshot(\`\${taskId}-main\`); // Get accessibility tree
const element = await client.selectSnapshotRef(\`\${taskId}-main\`, "e5"); // Get element by ref
\`\`\`

The \`page\` object is a standard Playwright Page.
</api-reference>

<api-reference name="screenshots">
IMPORTANT: Always prefix screenshot filenames with taskId to avoid collisions with parallel tasks:
\`\`\`typescript
const taskId = process.env.ACCOMPLISH_TASK_ID || 'default';
await page.screenshot({ path: \`tmp/\${taskId}-screenshot.png\` });
await page.screenshot({ path: \`tmp/\${taskId}-full.png\`, fullPage: true });
\`\`\`
</api-reference>

<api-reference name="aria-snapshot">
Use \`getAISnapshot()\` to discover page elements. Returns YAML-formatted accessibility tree with refs like \`[ref=e1]\`. Then use \`selectSnapshotRef()\` to interact:

<example name="aria-snapshot-usage">
\`\`\`typescript
const taskId = process.env.ACCOMPLISH_TASK_ID || 'default';
const snapshot = await client.getAISnapshot(\`\${taskId}-main\`);
console.log(snapshot); // Find the ref you need

const element = await client.selectSnapshotRef(\`\${taskId}-main\`, "e2");
await element.click();
\`\`\`
</example>
</api-reference>

<error-recovery>
Page state persists after failures. Debug by reconnecting and taking a screenshot:

<example name="debug-screenshot">
\`\`\`bash
cat > /tmp/accomplish-\${ACCOMPLISH_TASK_ID:-default}.mts <<'EOF'
import { connect } from "@/client.js";

const taskId = process.env.ACCOMPLISH_TASK_ID || 'default';
const client = await connect();
const page = await client.page(\`\${taskId}-main\`);

await page.screenshot({ path: \`tmp/\${taskId}-debug.png\` });
console.log({ url: page.url(), title: await page.title() });

await client.disconnect();
EOF
cd {{SKILLS_PATH}}/dev-browser && PATH="\${NODE_BIN_PATH}:\$PATH" npx tsx /tmp/accomplish-\${ACCOMPLISH_TASK_ID:-default}.mts
\`\`\`
</example>
</error-recovery>

<login-pages>
When you encounter a login page (e.g., Google Sign-In, OAuth screens, authentication prompts):
- Do NOT say you cannot log in or suggest alternative approaches
- Instead, ASK the user to log in manually in the browser window
- Take a screenshot to show the user the login page
- Say something like: "I've reached a login page. Please log in to your account in the browser window, then let me know when you're done."
- WAIT for the user to confirm they've logged in before continuing
- After the user confirms login, take another screenshot to verify you're past the login screen
- Then continue with the original task

This interactive login flow is essential because:
- Users expect to authenticate themselves for security
- Many services require human verification (CAPTCHAs, 2FA)
- The agent should not give up on tasks that require authentication
</login-pages>

<filesystem>
For saving/downloading content:
- Use browser's native download (click download buttons, Save As)
- Chrome handles downloads with its own permissions
- For text/data, copy to clipboard so users can paste where they want
</filesystem>
</skill>

<important name="user-communication">
CRITICAL: The user CANNOT see your text output or CLI prompts!
To ask ANY question or get user input, you MUST use the AskUserQuestion MCP tool.
See the ask-user-question skill for full documentation and examples.
</important>


<behavior>
- Use AskUserQuestion tool for clarifying questions before starting ambiguous tasks
- Write small, focused scripts - each does ONE thing
- After each script, evaluate the output before deciding next steps
- Be concise - don't narrate every internal action
- Hide implementation details - describe actions in user terms
- For multi-step tasks, summarize at the end rather than narrating each step
- Don't explain what bash commands you're running - just run them silently
- Don't announce server checks or startup - proceed directly to the task
- Only speak to the user when you have meaningful results or need input
</behavior>
`;

interface AgentConfig {
  description?: string;
  prompt?: string;
  mode?: 'primary' | 'subagent' | 'all';
}

interface McpServerConfig {
  type?: 'local' | 'remote';
  command?: string[];
  url?: string;
  enabled?: boolean;
  environment?: Record<string, string>;
  timeout?: number;
}

interface OllamaProviderModelConfig {
  name: string;
  tools?: boolean;
}

interface OllamaProviderConfig {
  npm: string;
  name: string;
  options: {
    baseURL: string;
  };
  models: Record<string, OllamaProviderModelConfig>;
}

interface BedrockProviderConfig {
  options: {
    region: string;
    profile?: string;
  };
}

interface OpenRouterProviderModelConfig {
  name: string;
  tools?: boolean;
}

interface OpenRouterProviderConfig {
  npm: string;
  name: string;
  options: {
    baseURL: string;
  };
  models: Record<string, OpenRouterProviderModelConfig>;
}

interface LiteLLMProviderModelConfig {
  name: string;
  tools?: boolean;
}

interface LiteLLMProviderConfig {
  npm: string;
  name: string;
  options: {
    baseURL: string;
    apiKey?: string;
  };
  models: Record<string, LiteLLMProviderModelConfig>;
}

interface ZaiProviderModelConfig {
  name: string;
  tools?: boolean;
}

interface ZaiProviderConfig {
  npm: string;
  name: string;
  options: {
    baseURL: string;
  };
  models: Record<string, ZaiProviderModelConfig>;
}

type ProviderConfig = OllamaProviderConfig | BedrockProviderConfig | OpenRouterProviderConfig | LiteLLMProviderConfig | ZaiProviderConfig;

interface OpenCodeConfig {
  $schema?: string;
  model?: string;
  default_agent?: string;
  enabled_providers?: string[];
  permission?: string | Record<string, string | Record<string, string>>;
  agent?: Record<string, AgentConfig>;
  mcp?: Record<string, McpServerConfig>;
  provider?: Record<string, ProviderConfig>;
}

/**
 * Generate OpenCode configuration file
 * OpenCode reads config from .opencode.json in the working directory or
 * from ~/.config/opencode/opencode.json
 */
export async function generateOpenCodeConfig(systemPromptAppend?: string): Promise<string> {
  const configDir = path.join(app.getPath('userData'), 'opencode');
  const configPath = path.join(configDir, 'opencode.json');

  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Get skills directory path and inject into system prompt
  const skillsPath = getSkillsPath();
  const baseSystemPrompt = ACCOMPLISH_SYSTEM_PROMPT_TEMPLATE.replace(/\{\{SKILLS_PATH\}\}/g, skillsPath);
  const systemPrompt = systemPromptAppend
    ? `${baseSystemPrompt}\n\n${systemPromptAppend}`
    : baseSystemPrompt;

  // Get OpenCode config directory (parent of skills/) for OPENCODE_CONFIG_DIR
  const openCodeConfigDir = getOpenCodeConfigDir();

  console.log('[OpenCode Config] Skills path:', skillsPath);
  console.log('[OpenCode Config] OpenCode config dir:', openCodeConfigDir);

  // Build file-permission MCP server command
  const filePermissionServerPath = path.join(skillsPath, 'file-permission', 'src', 'index.ts');

  // Enable providers - add ollama and litellm if configured
  const ollamaConfig = getOllamaConfig();
  const litellmConfig = getLiteLLMConfig();
  const baseProviders = ['anthropic', 'openai', 'openrouter', 'google', 'xai', 'deepseek', 'zai-coding-plan', 'amazon-bedrock'];
  let enabledProviders = [...baseProviders];
  if (ollamaConfig?.enabled) {
    enabledProviders.push('ollama');
  }
  if (litellmConfig?.enabled) {
    enabledProviders.push('litellm');
  }

  // Build provider configurations
  const providerConfig: Record<string, ProviderConfig> = {};

  // Add Ollama provider configuration if enabled
  if (ollamaConfig?.enabled && ollamaConfig.models && ollamaConfig.models.length > 0) {
    const ollamaModels: Record<string, OllamaProviderModelConfig> = {};
    for (const model of ollamaConfig.models) {
      ollamaModels[model.id] = {
        name: model.displayName,
        tools: true,  // Enable tool calling for all models
      };
    }

    providerConfig.ollama = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: {
        baseURL: `${ollamaConfig.baseUrl}/v1`,  // OpenAI-compatible endpoint
      },
      models: ollamaModels,
    };

    console.log('[OpenCode Config] Ollama provider configured with models:', Object.keys(ollamaModels));
  }

  // Add OpenRouter provider configuration if API key is set
  const openrouterKey = getApiKey('openrouter');
  if (openrouterKey) {
    // Get the selected model to configure OpenRouter
    const { getSelectedModel } = await import('../store/appSettings');
    const selectedModel = getSelectedModel();

    const openrouterModels: Record<string, OpenRouterProviderModelConfig> = {};

    // If a model is selected via OpenRouter, add it to the config
    if (selectedModel?.provider === 'openrouter' && selectedModel.model) {
      // Extract model ID from full ID (e.g., "openrouter/anthropic/claude-3.5-sonnet" -> "anthropic/claude-3.5-sonnet")
      const modelId = selectedModel.model.replace('openrouter/', '');
      openrouterModels[modelId] = {
        name: modelId,
        tools: true,
      };
    }

    // Only configure OpenRouter if we have at least one model
    if (Object.keys(openrouterModels).length > 0) {
      providerConfig.openrouter = {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenRouter',
        options: {
          baseURL: 'https://openrouter.ai/api/v1',
        },
        models: openrouterModels,
      };
      console.log('[OpenCode Config] OpenRouter provider configured with model:', Object.keys(openrouterModels));
    }
  }

  // Add Bedrock provider configuration if credentials are stored
  const bedrockCredsJson = getApiKey('bedrock');
  if (bedrockCredsJson) {
    try {
      const creds = JSON.parse(bedrockCredsJson) as BedrockCredentials;

      const bedrockOptions: BedrockProviderConfig['options'] = {
        region: creds.region || 'us-east-1',
      };

      // Only add profile if using profile mode
      if (creds.authType === 'profile' && creds.profileName) {
        bedrockOptions.profile = creds.profileName;
      }

      providerConfig['amazon-bedrock'] = {
        options: bedrockOptions,
      };

      console.log('[OpenCode Config] Bedrock provider configured:', bedrockOptions);
    } catch (e) {
      console.warn('[OpenCode Config] Failed to parse Bedrock credentials:', e);
    }
  }

  // Add LiteLLM provider configuration if enabled
  if (litellmConfig?.enabled && litellmConfig.baseUrl) {
    // Get the selected model to configure LiteLLM
    const { getSelectedModel } = await import('../store/appSettings');
    const selectedModel = getSelectedModel();

    const litellmModels: Record<string, LiteLLMProviderModelConfig> = {};

    // If a model is selected via LiteLLM, add it to the config
    if (selectedModel?.provider === 'litellm' && selectedModel.model) {
      // Extract model ID from full ID (e.g., "litellm/openai/gpt-4" -> "openai/gpt-4")
      const modelId = selectedModel.model.replace('litellm/', '');
      litellmModels[modelId] = {
        name: modelId,
        tools: true,
      };
    }

    // Only configure LiteLLM if we have at least one model
    if (Object.keys(litellmModels).length > 0) {
      // Get LiteLLM API key if configured
      const litellmApiKey = getApiKey('litellm');

      const litellmOptions: LiteLLMProviderConfig['options'] = {
        baseURL: `${litellmConfig.baseUrl}/v1`,
      };

      // Add API key to options if available
      if (litellmApiKey) {
        litellmOptions.apiKey = litellmApiKey;
        console.log('[OpenCode Config] LiteLLM API key configured');
      }

      providerConfig.litellm = {
        npm: '@ai-sdk/openai-compatible',
        name: 'LiteLLM',
        options: litellmOptions,
        models: litellmModels,
      };
      console.log('[OpenCode Config] LiteLLM provider configured with model:', Object.keys(litellmModels));
    }
  }

  // Add Z.AI Coding Plan provider configuration with all supported models
  // This is needed because OpenCode's built-in zai-coding-plan provider may not have all models
  const zaiKey = getApiKey('zai');
  if (zaiKey) {
    const zaiModels: Record<string, ZaiProviderModelConfig> = {
      'glm-4.7-flashx': { name: 'GLM-4.7 FlashX (Latest)', tools: true },
      'glm-4.7': { name: 'GLM-4.7', tools: true },
      'glm-4.7-flash': { name: 'GLM-4.7 Flash', tools: true },
      'glm-4.6': { name: 'GLM-4.6', tools: true },
      'glm-4.5-flash': { name: 'GLM-4.5 Flash', tools: true },
    };

    providerConfig['zai-coding-plan'] = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Z.AI Coding Plan',
      options: {
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      },
      models: zaiModels,
    };
    console.log('[OpenCode Config] Z.AI Coding Plan provider configured with models:', Object.keys(zaiModels));
  }

  const config: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    default_agent: ACCOMPLISH_AGENT_NAME,
    // Enable all supported providers - providers auto-configure when API keys are set via env vars
    enabled_providers: enabledProviders,
    // Auto-allow all tool permissions - the system prompt instructs the agent to use
    // AskUserQuestion for user confirmations, which shows in the UI as an interactive modal.
    // CLI-level permission prompts don't show in the UI and would block task execution.
    permission: 'allow',
    provider: Object.keys(providerConfig).length > 0 ? providerConfig : undefined,
    agent: {
      [ACCOMPLISH_AGENT_NAME]: {
        description: 'Browser automation assistant using dev-browser',
        prompt: systemPrompt,
        mode: 'primary',
      },
    },
    // MCP servers for additional tools
    mcp: {
      'file-permission': {
        type: 'local',
        command: ['npx', 'tsx', filePermissionServerPath],
        enabled: true,
        environment: {
          PERMISSION_API_PORT: String(PERMISSION_API_PORT),
        },
        timeout: 10000,
      },
      'ask-user-question': {
        type: 'local',
        command: ['npx', 'tsx', path.join(skillsPath, 'ask-user-question', 'src', 'index.ts')],
        enabled: true,
        environment: {
          QUESTION_API_PORT: String(QUESTION_API_PORT),
        },
        timeout: 10000,
      },
    },
  };

  // Write config file
  const configJson = JSON.stringify(config, null, 2);
  fs.writeFileSync(configPath, configJson);

  // Set environment variables for OpenCode to find the config and skills
  process.env.OPENCODE_CONFIG = configPath;
  process.env.OPENCODE_CONFIG_DIR = openCodeConfigDir;

  console.log('[OpenCode Config] Generated config at:', configPath);
  console.log('[OpenCode Config] Full config:', configJson);
  console.log('[OpenCode Config] OPENCODE_CONFIG env set to:', process.env.OPENCODE_CONFIG);
  console.log('[OpenCode Config] OPENCODE_CONFIG_DIR env set to:', process.env.OPENCODE_CONFIG_DIR);

  return configPath;
}

/**
 * Get the path where OpenCode config is stored
 */
export function getOpenCodeConfigPath(): string {
  return path.join(app.getPath('userData'), 'opencode', 'opencode.json');
}

/**
 * Get the path to OpenCode CLI's auth.json
 * OpenCode stores credentials in ~/.local/share/opencode/auth.json
 */
export function getOpenCodeAuthPath(): string {
  const homeDir = app.getPath('home');
  if (process.platform === 'win32') {
    return path.join(homeDir, 'AppData', 'Local', 'opencode', 'auth.json');
  }
  return path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');
}

/**
 * Sync API keys from Openwork's secure storage to OpenCode CLI's auth.json
 * This allows OpenCode CLI to recognize DeepSeek and Z.AI providers
 */
export async function syncApiKeysToOpenCodeAuth(): Promise<void> {
  const { getAllApiKeys } = await import('../store/secureStorage');
  const apiKeys = await getAllApiKeys();

  const authPath = getOpenCodeAuthPath();
  const authDir = path.dirname(authPath);

  // Ensure directory exists
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // Read existing auth.json or create empty object
  let auth: Record<string, { type: string; key: string }> = {};
  if (fs.existsSync(authPath)) {
    try {
      auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    } catch (e) {
      console.warn('[OpenCode Auth] Failed to parse existing auth.json, creating new one');
      auth = {};
    }
  }

  let updated = false;

  // Sync DeepSeek API key
  if (apiKeys.deepseek) {
    if (!auth['deepseek'] || auth['deepseek'].key !== apiKeys.deepseek) {
      auth['deepseek'] = { type: 'api', key: apiKeys.deepseek };
      updated = true;
      console.log('[OpenCode Auth] Synced DeepSeek API key');
    }
  }

  // Sync Z.AI Coding Plan API key (maps to 'zai-coding-plan' provider in OpenCode CLI)
  if (apiKeys.zai) {
    if (!auth['zai-coding-plan'] || auth['zai-coding-plan'].key !== apiKeys.zai) {
      auth['zai-coding-plan'] = { type: 'api', key: apiKeys.zai };
      updated = true;
      console.log('[OpenCode Auth] Synced Z.AI Coding Plan API key');
    }
  }

  // Write updated auth.json
  if (updated) {
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
    console.log('[OpenCode Auth] Updated auth.json at:', authPath);
  }
}
