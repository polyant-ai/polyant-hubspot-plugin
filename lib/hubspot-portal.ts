// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Resolves the HubSpot portal ID for a given API key.
 * Cached in-memory (1h TTL) to avoid repeated API calls.
 */

import { hubspotFetch } from "./hubspot-fetch.js";
import { TtlCache } from "./ttl-cache.js";

const cache = new TtlCache<string, string>({ maxSize: 50, ttlMs: 60 * 60 * 1000 }); // 1 hour

export async function getHubSpotPortalId(
  apiKey: string,
): Promise<string | null> {
  const cached = cache.get(apiKey);
  if (cached) {
    return cached;
  }

  try {
    const response = await hubspotFetch(
      "https://api.hubapi.com/account-info/v3/details",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (!response.ok) return null;

    const data = (await response.json()) as { portalId: number };
    const portalId = String(data.portalId);

    cache.set(apiKey, portalId);
    return portalId;
  } catch (err) {
    console.error("[HubSpot] Failed to resolve portal ID:", err);
    return null;
  }
}

/** Build a direct HubSpot URL for a CRM object. Returns null if portalId is unavailable. */
export function hubspotUrl(
  portalId: string | null,
  objectType: "contact" | "company" | "deal" | "ticket",
  objectId: string,
): string | null {
  if (!portalId) return null;
  return `https://app.hubspot.com/contacts/${portalId}/${objectType}/${objectId}`;
}
