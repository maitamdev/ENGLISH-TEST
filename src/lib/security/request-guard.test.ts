import { describe, expect, it } from "vitest";
import { applySecurityHeaders, guardStateChangingRequest } from "./request-guard";

const base = { method: "POST", pathname: "/api/answers", origin: "https://lexiduel.example", referer: null, fetchSite: "same-origin", targetOrigin: "https://lexiduel.example" };

describe("request security guard", () => {
  it("allows same-origin mutations", () => expect(guardStateChangingRequest(base)).toEqual({ allowed: true }));
  it("blocks cross-site and sibling-subdomain mutations", () => {
    expect(guardStateChangingRequest({ ...base, fetchSite: "cross-site", origin: "https://evil.example" })).toEqual({ allowed: false, code: "cross_site" });
    expect(guardStateChangingRequest({ ...base, fetchSite: "same-site", origin: "https://other.lexiduel.example" })).toEqual({ allowed: false, code: "cross_site" });
  });
  it("falls back to an exact referer origin", () => {
    expect(guardStateChangingRequest({ ...base, origin: null, referer: "https://lexiduel.example/room/ABC" })).toEqual({ allowed: true });
    expect(guardStateChangingRequest({ ...base, origin: null, referer: "https://lexiduel.example.attacker.test/" })).toEqual({ allowed: false, code: "origin_mismatch" });
  });
  it("does not apply browser CSRF rules to safe methods or internal workers", () => {
    expect(guardStateChangingRequest({ ...base, method: "GET", fetchSite: "cross-site" })).toEqual({ allowed: true });
    expect(guardStateChangingRequest({ ...base, pathname: "/api/internal/maintenance-worker", origin: null, fetchSite: null })).toEqual({ allowed: true });
  });
  it("fails closed when an unsafe browser request has no verifiable source", () => {
    expect(guardStateChangingRequest({ ...base, origin: null, referer: null, fetchSite: null })).toEqual({ allowed: false, code: "cross_site" });
    expect(guardStateChangingRequest({ ...base, origin: null, referer: null, fetchSite: "same-origin" })).toEqual({ allowed: true });
  });
  it("sets private API and browser hardening headers", () => {
    const headers = new Headers({ Vary: "RSC" }); applySecurityHeaders(headers, { api: true, production: true });
    expect(headers.get("cache-control")).toContain("no-store");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("permissions-policy")).toContain("microphone=(self)");
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(headers.get("vary")).toContain("RSC");
    expect(headers.get("strict-transport-security")).toContain("includeSubDomains");
  });
});
