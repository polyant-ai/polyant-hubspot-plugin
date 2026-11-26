// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RequiredSecretSpec } from "@polyant-ai/plugin-sdk";

/** The configuration every HubSpot tool declares: the Service Key or private app token. */
export const HUBSPOT_SECRETS: RequiredSecretSpec[] = [
  {
    key: "hubspot_api_key",
    type: "text",
    label: { "en-US": "HubSpot Service Key", "it-IT": "Service Key HubSpot" },
    description: {
      "en-US": "Token of a HubSpot Service Key, created under Development → Keys → Service keys (or Settings → Integrations → Service Keys) in your HubSpot account. The token of an existing legacy private app is also accepted.",
      "it-IT": "Token di una Service Key HubSpot, che crei nel tuo account HubSpot in Sviluppo → Chiavi → Service Keys (oppure Impostazioni → Integrazioni → Service Keys). È accettato anche il token di un'app privata legacy già esistente.",
    },
  },
];
