"use strict";

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

module.exports = {
  defaultLoadBinding,
  validateNativeBinding,
};
