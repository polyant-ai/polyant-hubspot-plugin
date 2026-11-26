// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Resolves the HubSpot portal ID for a given API key.
 * Cached in-memory (1h TTL) to avoid repeated API calls.
 */

import { describeAuthFailure, hubspotFetch } from "./hubspot-fetch.js";
import { TtlCache } from "./ttl-cache.js";

const cache = new TtlCache<string, string>({ maxSize: 50, ttlMs: 60 * 60 * 1000 }); // 1 hour

/** Portal ID, or null with a warning when HubSpot refused the token. */
export interface HubSpotPortalLookup {
  portalId: string | null;
  /** Set when HubSpot answered 401/403: the record URLs in the result are null. */
  warning?: string;
}

/**
 * Resolve the portal ID and say why it is missing when the cause is the token.
 *
 * A 401 or 403 from the account-info API comes back as a warning that the
 * tool adds to its result, so the agent learns that record URLs are missing
 * because of the token and not because the records lack one. Any other
 * failure (network, 5xx) stays silent: URLs are an enrichment and the next
 * call retries the lookup.
 */
export async function resolveHubSpotPortal(apiKey: string): Promise<HubSpotPortalLookup> {
  const cached = cache.get(apiKey);
  if (cached) {
    return { portalId: cached };
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

    if (!response.ok) {
      const authFailure = describeAuthFailure(response.status, "reading the account details");
      return authFailure
        ? { portalId: null, warning: `${authFailure} Record URLs are omitted from this result.` }
        : { portalId: null };
    }

    const data = (await response.json()) as { portalId: number };
    const portalId = String(data.portalId);

    cache.set(apiKey, portalId);
    return { portalId };
  } catch (err) {
    console.error("[HubSpot] Failed to resolve portal ID:", err);
    return { portalId: null };
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

/**
 * The `warnings` field of a tool result: present only when there is at least
 * one warning, so results without problems keep their previous shape.
 */
export function warningsField(
  ...items: Array<string | undefined | readonly string[]>
): { warnings?: string[] } {
  const warnings = items.flatMap((item) => (item === undefined ? [] : typeof item === "string" ? [item] : [...item]));
  return warnings.length > 0 ? { warnings } : {};
}
