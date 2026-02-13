import { describe, it, expect } from "vitest";
import {
  isJsonRpcResponse,
  isJsonRpcFailure,
  isJsonRpcRequest,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "./types.js";

describe("isJsonRpcResponse", () => {
  it("returns true for a success response", () => {
    const msg: JsonRpcMessage = { id: 1, result: "ok" };
    expect(isJsonRpcResponse(msg)).toBe(true);
  });

  it("returns true for a failure response", () => {
    const msg: JsonRpcMessage = { id: 1, error: { code: -1, message: "fail" } };
    expect(isJsonRpcResponse(msg)).toBe(true);
  });

  it("returns false for a request", () => {
    const msg: JsonRpcMessage = { id: 1, method: "foo" };
    expect(isJsonRpcResponse(msg)).toBe(false);
  });

  it("returns false for a notification", () => {
    const msg: JsonRpcMessage = { method: "notify" };
    expect(isJsonRpcResponse(msg)).toBe(false);
  });
});

describe("isJsonRpcFailure", () => {
  it("returns true when error field present", () => {
    const msg: JsonRpcResponse = { id: 1, error: { code: -32600, message: "Invalid" } };
    expect(isJsonRpcFailure(msg)).toBe(true);
  });

  it("returns false for success response", () => {
    const msg: JsonRpcResponse = { id: 1, result: { data: 42 } };
    expect(isJsonRpcFailure(msg)).toBe(false);
  });
});

describe("isJsonRpcRequest", () => {
  it("returns true for a valid request with numeric id", () => {
    const msg: JsonRpcMessage = { id: 1, method: "doStuff" };
    expect(isJsonRpcRequest(msg)).toBe(true);
  });

  it("returns true for a valid request with string id", () => {
    const msg: JsonRpcMessage = { id: "abc", method: "doStuff" };
    expect(isJsonRpcRequest(msg)).toBe(true);
  });

  it("returns false when id is null (treated as notification)", () => {
    const msg: JsonRpcMessage = { id: null, method: "notify" };
    expect(isJsonRpcRequest(msg)).toBe(false);
  });

  it("returns false for a notification without id", () => {
    const msg: JsonRpcMessage = { method: "notify" };
    expect(isJsonRpcRequest(msg)).toBe(false);
  });

  it("returns false for a response", () => {
    const msg: JsonRpcMessage = { id: 1, result: 42 };
    expect(isJsonRpcRequest(msg)).toBe(false);
  });
});
