// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveHubSpotPortal, warningsField } from "./hubspot-portal.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

describe("resolveHubSpotPortal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the portal id without a warning", async () => {
    mockFetch.mockResolvedValueOnce(createResponse({ portalId: 11111111 }));

    await expect(resolveHubSpotPortal("portal-ok")).resolves.toEqual({ portalId: "11111111" });
  });

  it("returns a warning naming the status on 403", async () => {
    mockFetch.mockResolvedValueOnce(createResponse({ message: "forbidden" }, 403));

    const result = await resolveHubSpotPortal("portal-403");

    expect(result.portalId).toBeNull();
    expect(result.warning).toContain("403");
    expect(result.warning).toContain("Record URLs are omitted");
  });

  it("returns a warning naming the status on 401", async () => {
    mockFetch.mockResolvedValueOnce(createResponse({ message: "unauthorized" }, 401));

    const result = await resolveHubSpotPortal("portal-401");

    expect(result.portalId).toBeNull();
    expect(result.warning).toContain("401");
  });

  it("stays silent on a server error, which is transient", async () => {
    mockFetch.mockResolvedValueOnce(createResponse({ message: "oops" }, 503));

    await expect(resolveHubSpotPortal("portal-503")).resolves.toEqual({ portalId: null });
  });

  it("does not cache a failure: the next call asks HubSpot again", async () => {
    mockFetch
      .mockResolvedValueOnce(createResponse({ message: "forbidden" }, 403))
      .mockResolvedValueOnce(createResponse({ portalId: 22222222 }));

    await resolveHubSpotPortal("portal-retry");
    const second = await resolveHubSpotPortal("portal-retry");

    expect(second).toEqual({ portalId: "22222222" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("warningsField", () => {
  it("is empty when there is nothing to report", () => {
    expect(warningsField(undefined, [])).toEqual({});
  });

  it("flattens strings and lists in order", () => {
    expect(warningsField(["a", "b"], undefined, "c")).toEqual({ warnings: ["a", "b", "c"] });
  });
});
