import { describe, expect, it } from "vitest";
import { viewerHTML } from "../src/viewer/html";

describe("viewer UI T12", () => {
  it("contains the full v4 sharing UI entry points", () => {
    const html = viewerHTML();
    expect(html).toContain('id="memorySearchScope"');
    expect(html).toContain('id="taskShareActions"');
    expect(html).toContain('id="skillSearchInput"');
    expect(html).toContain('id="hubSkillsList"');
    expect(html).toContain('id="settingsSharingConfig"');
    expect(html).toContain('/api/sharing/status');
    expect(html).toContain('renderSharingMemorySearchResults');
    expect(html).toContain('/api/sharing/search/skills');
    expect(html).toContain('/api/sharing/tasks/share');
    expect(html).toContain('/api/sharing/skills/pull');
  });
});
