import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

describe("package manifest", () => {
  it("publishes the compiled OpenClaw entrypoint", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf-8"),
    ) as {
      type: string;
      main: string;
      files: string[];
      openclaw: { extensions: string[] };
      scripts: Record<string, string>;
    };
    const pluginJson = JSON.parse(
      fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf-8"),
    ) as { extensions: string[] };
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(root, "tsconfig.json"), "utf-8"),
    ) as { compilerOptions: { rootDir: string }; include: string[] };

    expect(packageJson.type).toBe("commonjs");
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(pluginJson.extensions).toEqual(["./dist/index.js"]);
    expect(tsconfig.compilerOptions.rootDir).toBe(".");
    expect(tsconfig.include).toContain("index.ts");
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "tsconfig.json"]));
    expect(packageJson.files).not.toContain("index.ts");
    expect(packageJson.scripts.prepublishOnly).toBe("npm run build");
  });
});
