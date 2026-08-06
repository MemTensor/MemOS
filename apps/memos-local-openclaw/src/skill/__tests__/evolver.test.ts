import { describe, it, expect, beforeEach, vi } from "vitest";
import { SkillEvolver } from "../evolver";
import type { SqliteStore } from "../../storage/sqlite";
import type { RecallEngine } from "../../recall/engine";
import type { PluginContext, Skill } from "../../types";

describe("SkillEvolver - autoInstall configuration", () => {
  let mockStore: SqliteStore;
  let mockEngine: RecallEngine;
  let mockContext: PluginContext;
  let evolver: SkillEvolver;

  beforeEach(() => {
    mockStore = {
      getSkill: vi.fn(),
      updateSkill: vi.fn(),
      setTaskSkillMeta: vi.fn(),
      getTasksBySkillStatus: vi.fn(() => []),
      getChunksByTask: vi.fn(() => []),
      setChunkSkillId: vi.fn(),
    } as any;

    mockEngine = {} as RecallEngine;

    mockContext = {
      workspaceDir: "/tmp/test-workspace",
      config: {},
      log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    } as any;

    evolver = new SkillEvolver(mockStore, mockEngine, mockContext);
  });

  it("should NOT auto-install when autoInstall is false, even for install_recommended skills", () => {
    // Setup: autoInstall explicitly disabled
    mockContext.config.skillEvolution = {
      enabled: true,
      autoInstall: false,
    };

    // Create a skill that would trigger install_recommended
    // (≥3 scripts, >20KB total size)
    const skill: Skill = {
      id: "test-skill-1",
      name: "test-skill",
      status: "active",
      version: 1,
      dirPath: "/tmp/skills/test-skill",
      installed: 0,
      description: "Test skill with many companion files",
      chunks: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Mock the installer's install method
    const installSpy = vi.fn();
    (evolver as any).installer = {
      install: installSpy,
    };

    // Call autoInstallIfNeeded
    (evolver as any).autoInstallIfNeeded(skill);

    // Assert: install should NOT be called when autoInstall is false
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("should auto-install when autoInstall is true", () => {
    // Setup: autoInstall enabled
    mockContext.config.skillEvolution = {
      enabled: true,
      autoInstall: true,
    };

    const skill: Skill = {
      id: "test-skill-2",
      name: "test-skill-2",
      status: "active",
      version: 1,
      dirPath: "/tmp/skills/test-skill-2",
      installed: 0,
      description: "Test skill",
      chunks: 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const installSpy = vi.fn();
    (evolver as any).installer = {
      install: installSpy,
    };

    // Call autoInstallIfNeeded
    (evolver as any).autoInstallIfNeeded(skill);

    // Assert: install should be called when autoInstall is true
    expect(installSpy).toHaveBeenCalledWith("test-skill-2");
  });

  it("should NOT auto-install when skill status is not active", () => {
    mockContext.config.skillEvolution = {
      enabled: true,
      autoInstall: true,
    };

    const skill: Skill = {
      id: "test-skill-3",
      name: "test-skill-3",
      status: "draft",
      version: 1,
      dirPath: "/tmp/skills/test-skill-3",
      installed: 0,
      description: "Draft skill",
      chunks: 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const installSpy = vi.fn();
    (evolver as any).installer = {
      install: installSpy,
    };

    (evolver as any).autoInstallIfNeeded(skill);

    // Assert: install should NOT be called for non-active skills
    expect(installSpy).not.toHaveBeenCalled();
  });
});
