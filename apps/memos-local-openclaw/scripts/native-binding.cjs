"use strict";

const fs = require("fs");
const path = require("path");

let lastQuarantineTimestamp = null;
let quarantineTimestampSequence = 0;

function errorMessage(error) {
  if (error && typeof error.message === "string") return error.message;
  return String(error || "Unknown native binding error");
}

function defaultLoadBinding(bindingPath) {
  process.dlopen({ exports: {} }, bindingPath);
}

function validateNativeBinding(bindingPath, loadBinding = defaultLoadBinding) {
  if (!bindingPath) {
    return { ok: false, reason: "missing", message: "Native binding path not found" };
  }

  try {
    loadBinding(bindingPath);
    return { ok: true, reason: "ok", message: "" };
  } catch (error) {
    const message = errorMessage(error);
    if (/NODE_MODULE_VERSION/.test(message)) {
      return { ok: false, reason: "node-module-version", message };
    }
    return { ok: false, reason: "load-error", message };
  }
}

function quarantineNativeBinding(
  bindingPath,
  fsImpl = fs,
  now = Date.now(),
  pathImpl = path,
) {
  if (!bindingPath || !fsImpl.existsSync(bindingPath)) {
    return { ok: false, quarantinedPath: "", reason: "missing" };
  }

  const parsed = pathImpl.parse(bindingPath);
  if (now === lastQuarantineTimestamp) {
    quarantineTimestampSequence += 1;
  } else {
    lastQuarantineTimestamp = now;
    quarantineTimestampSequence = 0;
  }
  const uniqueSuffix = quarantineTimestampSequence === 0
    ? `${now}`
    : `${now}-${quarantineTimestampSequence}`;
  const quarantinedPath = pathImpl.join(
    parsed.dir,
    `${parsed.name}.abi-mismatch-${uniqueSuffix}${parsed.ext}`,
  );

  try {
    fsImpl.renameSync(bindingPath, quarantinedPath);
    return { ok: true, quarantinedPath, reason: "renamed" };
  } catch (error) {
    try {
      fsImpl.unlinkSync(bindingPath);
      return { ok: true, quarantinedPath: "", reason: "removed" };
    } catch (unlinkError) {
      return { ok: false, quarantinedPath: "", reason: errorMessage(unlinkError) };
    }
  }
}

module.exports = {
  defaultLoadBinding,
  quarantineNativeBinding,
  validateNativeBinding,
};
