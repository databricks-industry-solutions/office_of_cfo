import { describe, expect, it } from "vitest";
import { COMPUTATIONAL_POST_PATHS, isReadOnlyRequest } from "./readonly.ts";

describe("isReadOnlyRequest", () => {
  it("allows every GET and HEAD read", () => {
    expect(isReadOnlyRequest("GET", "http://localhost:8012/api/tasks?scope=GLOBAL")).toBe(true);
    expect(isReadOnlyRequest("HEAD", "/api/close/status")).toBe(true);
    expect(isReadOnlyRequest("get", "/api/personas")).toBe(true); // case-insensitive
  });

  it("allows only the two reviewed computational POSTs", () => {
    expect(isReadOnlyRequest("POST", "/api/scenario/project")).toBe(true);
    expect(isReadOnlyRequest("POST", "/api/historical-insights/narrative")).toBe(true);
    // Full URL + query string must still resolve to the allowed path.
    expect(isReadOnlyRequest("POST", "http://127.0.0.1:8012/api/scenario/project?x=1")).toBe(true);
    expect(isReadOnlyRequest("post", "/api/historical-insights/narrative")).toBe(true);
  });

  it("blocks every other POST (writes disguised as computation)", () => {
    expect(isReadOnlyRequest("POST", "/api/scenario/commit")).toBe(false);
    expect(isReadOnlyRequest("POST", "/api/competitor/add")).toBe(false);
    expect(isReadOnlyRequest("POST", "/api/adjustments")).toBe(false);
    expect(isReadOnlyRequest("POST", "/api/close-support/upload")).toBe(false);
  });

  it("blocks every PUT, PATCH and DELETE", () => {
    expect(isReadOnlyRequest("PUT", "/api/scenario/project")).toBe(false);
    expect(isReadOnlyRequest("PATCH", "/api/scenario/plan/1")).toBe(false);
    expect(isReadOnlyRequest("DELETE", "/api/scenario/plan/1")).toBe(false);
  });

  it("exposes exactly the two allowed paths", () => {
    expect([...COMPUTATIONAL_POST_PATHS].sort()).toEqual([
      "/api/historical-insights/narrative",
      "/api/scenario/project",
    ]);
  });
});
