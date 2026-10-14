// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RequiredSecretSpec } from "@polyant-ai/plugin-sdk";

/** The configuration every HubSpot tool declares: the private app token. */
export const HUBSPOT_SECRETS: RequiredSecretSpec[] = [
  {
    key: "hubspot_api_key",
    type: "text",
    label: { "en-US": "HubSpot private app token", "it-IT": "Token dell'app privata HubSpot" },
    description: {
      "en-US": "Access token of a HubSpot private app, found under Settings → Integrations → Private Apps in your HubSpot account.",
      "it-IT": "Token di accesso di un'app privata HubSpot, che trovi in Impostazioni → Integrazioni → App private nel tuo account HubSpot.",
    },
  },
];
