import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.git(?:\/|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519)$/i,
  /\.(?:pem|p12|pfx|key)$/i,
];
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:^|[^A-Za-z0-9])npm_[A-Za-z0-9]{20,}/,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\/\/(?:registry\.)?npmjs\.org\/:_authToken\s*=/i,
  /Authorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]{20,}/,
  /(?:^|[^A-Z0-9])AKIA[0-9A-Z]{16}(?:[^A-Z0-9]|$)/,
];

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export function auditPackage(tarball) {
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const unsafeArchivePaths = listing.filter(
    (entry) =>
      entry.startsWith("/") ||
      entry.split("/").includes("..") ||
      !entry.startsWith("package/") ||
      FORBIDDEN_PATHS.some((pattern) => pattern.test(entry)),
  );
  if (unsafeArchivePaths.length > 0) {
    throw new Error(`package contains forbidden path: ${unsafeArchivePaths[0]}`);
  }
  const linkedEntries = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter((line) => /^[lh]/.test(line));
  if (linkedEntries.length > 0) {
    throw new Error("package contains a symbolic or hard link; refusing unsafe extraction");
  }

  const extractDirectory = mkdtempSync(join(tmpdir(), "memos-local-plugin-audit-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", extractDirectory]);
    const packageRoot = join(extractDirectory, "package");
    const files = collectFiles(packageRoot);
    const secretFiles = [];
    let scannedTextFileCount = 0;
    for (const file of files) {
      const size = statSync(file).size;
      if (size === 0 || size > 2 * 1024 * 1024) {
        continue;
      }
      const bytes = readFileSync(file);
      if (bytes.includes(0)) {
        continue;
      }
      scannedTextFileCount += 1;
      const text = bytes.toString("utf8");
      if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
        secretFiles.push(relative(packageRoot, file).split(sep).join("/"));
      }
    }
    if (secretFiles.length > 0) {
      throw new Error(`package contains a credential-like value in ${secretFiles[0]}`);
    }
    return {
      tarball: basename(tarball),
      archive_entry_count: listing.length,
      scanned_text_file_count: scannedTextFileCount,
      forbidden_path_count: 0,
      credential_finding_count: 0,
      status: "pass",
    };
  } finally {
    rmSync(extractDirectory, { recursive: true, force: true });
  }
}

export function main() {
  const tarball = process.env.RELEASE_TARBALL || "";
  const reportFile = process.env.PACKAGE_AUDIT_REPORT || "";
  if (!tarball || !reportFile) {
    throw new Error("RELEASE_TARBALL and PACKAGE_AUDIT_REPORT are required");
  }
  const report = auditPackage(tarball);
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Package audit passed for ${report.tarball}; scanned ${report.archive_entry_count} entries.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
