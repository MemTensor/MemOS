/**
 * Integration tests for OpenCode config generator
 *
 * Tests the config-generator module which creates OpenCode configuration files
 * with MCP servers, agent definitions, and system prompts.
 *
 * NOTE: This is a TRUE integration test.
 * - Uses REAL filesystem operations with temp directories
 * - Only mocks external dependencies (electron APIs)
 *
 * Mocked external services:
 * - electron.app: Native Electron APIs (getPath, getAppPath, isPackaged)
 *
 * Real implementations used:
 * - fs: Real filesystem operations in temp directories
 * - path: Real path operations
 *
 * @module __tests__/integration/main/opencode/config-generator.integration.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Create temp directories for each test
let tempUserDataDir: string;
let tempAppDir: string;

// Mock only the external electron module
const mockApp = {
  isPackaged: false,
  getAppPath: vi.fn(() => tempAppDir),
  getPath: vi.fn((name: string) => {
    if (name === 'userData') return tempUserDataDir;
    return path.join(tempUserDataDir, name);
  }),
};

vi.mock('electron', () => ({
  app: mockApp,
}));

// Mock permission-api module (internal but exports constants we need)
vi.mock('@main/permission-api', () => ({
  PERMISSION_API_PORT: 9999,
  QUESTION_API_PORT: 9227,
}));

describe('OpenCode Config Generator Integration', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    originalEnv = { ...process.env };
    mockApp.isPackaged = false;

    // Create real temp directories for each test
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-userData-'));
    tempAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-app-'));

    // Create skills directory structure in temp app dir
    const skillsDir = path.join(tempAppDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'file-permission', 'src'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'file-permission', 'src', 'index.ts'), '// mock file');

    // Update mock to use temp directories
    mockApp.getAppPath.mockReturnValue(tempAppDir);
    mockApp.getPath.mockImplementation((name: string) => {
      if (name === 'userData') return tempUserDataDir;
      return path.join(tempUserDataDir, name);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;

    // Clean up temp directories
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      fs.rmSync(tempAppDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getSkillsPath()', () => {
    describe('Development Mode', () => {
      it('should return skills path relative to app path in dev mode', async () => {
        // Arrange
        mockApp.isPackaged = false;

        // Act
        const { getSkillsPath } = await import('@main/opencode/config-generator');
        const result = getSkillsPath();

        // Assert
        expect(result).toBe(path.join(tempAppDir, 'skills'));
      });
    });

    describe('Packaged Mode', () => {
      it('should return skills path in resources folder when packaged', async () => {
        // Arrange
        mockApp.isPackaged = true;
        const resourcesPath = path.join(tempAppDir, 'Resources');
        fs.mkdirSync(resourcesPath, { recursive: true });
        (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = resourcesPath;

        // Act
        const { getSkillsPath } = await import('@main/opencode/config-generator');
        const result = getSkillsPath();

        // Assert
        expect(result).toBe(path.join(resourcesPath, 'skills'));
      });
    });
  });

  describe('generateOpenCodeConfig()', () => {
    it('should create config directory if it does not exist', async () => {
      // Arrange - config dir does not exist initially

      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      await generateOpenCodeConfig();

      // Assert - verify directory was created using real fs
      const configDir = path.join(tempUserDataDir, 'opencode');
      expect(fs.existsSync(configDir)).toBe(true);
    });

    it('should not recreate directory if it already exists', async () => {
      // Arrange - create config dir beforehand
      const configDir = path.join(tempUserDataDir, 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
      const statBefore = fs.statSync(configDir);

      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      await generateOpenCodeConfig();

      // Assert - directory still exists, no error
      expect(fs.existsSync(configDir)).toBe(true);
    });

    it('should write config file with correct structure', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const configPath = await generateOpenCodeConfig();

      // Assert - read the real file
      expect(fs.existsSync(configPath)).toBe(true);
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent);

      expect(config.$schema).toBe('https://opencode.ai/config.json');
      expect(config.default_agent).toBe('accomplish');
      expect(config.permission).toBe('allow');
      expect(config.enabled_providers).toContain('anthropic');
      expect(config.enabled_providers).toContain('openai');
      expect(config.enabled_providers).toContain('google');
    });

    it('should include accomplish agent configuration', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const configPath = await generateOpenCodeConfig();

      // Assert
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const agent = config.agent['accomplish'];

      expect(agent).toBeDefined();
      expect(agent.description).toBe('Browser automation assistant using dev-browser');
      expect(agent.mode).toBe('primary');
      expect(typeof agent.prompt).toBe('string');
      expect(agent.prompt.length).toBeGreaterThan(0);
    });

    it('should include MCP server configuration for file-permission', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const configPath = await generateOpenCodeConfig();

      // Assert
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const filePermission = config.mcp['file-permission'];

      expect(filePermission).toBeDefined();
      expect(filePermission.type).toBe('local');
      expect(filePermission.enabled).toBe(true);
      expect(filePermission.command[0]).toBe('npx');
      expect(filePermission.command[1]).toBe('tsx');
      expect(filePermission.environment.PERMISSION_API_PORT).toBe('9999');
    });

    it('should inject skills path into system prompt', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const configPath = await generateOpenCodeConfig();

      // Assert
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const prompt = config.agent['accomplish'].prompt;
      const skillsPath = path.join(tempAppDir, 'skills');

      // Prompt should contain the actual skills path, not the template placeholder
      expect(prompt).toContain(skillsPath);
      expect(prompt).not.toContain('{{SKILLS_PATH}}');
    });

    it('should set OPENCODE_CONFIG environment variable after generation', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const configPath = await generateOpenCodeConfig();

      // Assert
      expect(process.env.OPENCODE_CONFIG).toBe(configPath);
      expect(configPath).toBe(path.join(tempUserDataDir, 'opencode', 'opencode.json'));
    });

    it('should return the config file path', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const result = await generateOpenCodeConfig();

      // Assert
      expect(result).toBe(path.join(tempUserDataDir, 'opencode', 'opencode.json'));
      expect(fs.existsSync(result)).toBe(true);
    });
  });

  describe('getOpenCodeConfigPath()', () => {
    it('should return config path in userData directory', async () => {
      // Act
      const { getOpenCodeConfigPath } = await import('@main/opencode/config-generator');
      const result = getOpenCodeConfigPath();

      // Assert
      expect(result).toBe(path.join(tempUserDataDir, 'opencode', 'opencode.json'));
    });
  });

  describe('System Prompt Content', () => {
    it('should include browser automation guidance', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const configPath = await generateOpenCodeConfig();

      // Assert
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const prompt = config.agent['accomplish'].prompt;

      expect(prompt).toContain('browser');
      expect(prompt.toLowerCase()).toContain('playwright');
    });

    it('should include file permission rules', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const configPath = await generateOpenCodeConfig();

      // Assert
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const prompt = config.agent['accomplish'].prompt;

      expect(prompt).toContain('FILE PERMISSION WORKFLOW');
      expect(prompt).toContain('request_file_permission');
    });

    it('should include user communication guidance', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const configPath = await generateOpenCodeConfig();

      // Assert
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const prompt = config.agent['accomplish'].prompt;

      expect(prompt).toContain('user-communication');
      expect(prompt).toContain('AskUserQuestion');
    });
  });

  describe('ACCOMPLISH_AGENT_NAME Export', () => {
    it('should export the agent name constant', async () => {
      // Act
      const { ACCOMPLISH_AGENT_NAME } = await import('@main/opencode/config-generator');

      // Assert
      expect(ACCOMPLISH_AGENT_NAME).toBe('accomplish');
    });
  });

  describe('Config File Persistence', () => {
    it('should overwrite existing config file on regeneration', async () => {
      // Arrange - generate config first time
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const firstPath = await generateOpenCodeConfig();
      const firstContent = fs.readFileSync(firstPath, 'utf-8');

      // Reset modules to re-run generator
      vi.resetModules();

      // Act - generate again
      const { generateOpenCodeConfig: regenerate } = await import('@main/opencode/config-generator');
      const secondPath = await regenerate();
      const secondContent = fs.readFileSync(secondPath, 'utf-8');

      // Assert - same path, same content structure
      expect(firstPath).toBe(secondPath);
      expect(JSON.parse(firstContent).$schema).toBe(JSON.parse(secondContent).$schema);
    });

    it('should create valid JSON that can be parsed', async () => {
      // Act
      const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
      const configPath = await generateOpenCodeConfig();

      // Assert - should not throw when parsing
      const content = fs.readFileSync(configPath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();

      // Should be pretty-printed (contains newlines)
      expect(content).toContain('\n');
    });
  });
});
