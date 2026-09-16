import { describe, expect, it } from "vitest";

import { RPC_METHODS, isRpcMethodName } from "../../../agent-contract/jsonrpc.js";

describe("gain maintenance RPC contract", () => {
  it("registers policies.gainPreview and policies.gainRollback with exact names", () => {
    expect(RPC_METHODS.POLICIES_GAIN_PREVIEW).toBe("policies.gainPreview");
    expect(RPC_METHODS.POLICIES_GAIN_ROLLBACK).toBe("policies.gainRollback");
    expect(isRpcMethodName("policies.gainPreview")).toBe(true);
    expect(isRpcMethodName("policies.gainRollback")).toBe(true);
  });
});
