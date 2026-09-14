// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import type { ToolContext } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../lib/error.js";
import { auditPreview } from "../lib/audit-preview.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES, buildPhoneFilterGroups, resolveOwnerNames } from "../lib/hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "../lib/hubspot-portal.js";

const HUBSPOT_FILTER_OPERATORS = [
  "EQ",
  "NEQ",
  "HAS_PROPERTY",
  "NOT_HAS_PROPERTY",
  "CONTAINS_TOKEN",
  "GT",
  "GTE",
  "LT",
  "LTE",
] as const;

export default defineTool({
  name: "contact",
  description:
    "Crea, aggiorna o cerca contatti nel CRM HubSpot (action: create | update | search).\n" +
    "In 'search' serve almeno uno tra phone, name, email, contactId (= get-by-id) o filters (telefono fuzzy); 'create' vuole almeno email o telefono per evitare duplicati; 'update' richiede contactId.\n" +
    "Per proprietà custom del portale: customProperties in create/update, filters + returnProperties in search.\n" +
    "Se la risposta include nextAfter, ripeti passando quel valore come after per paginare.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Cerca per telefono",
      input: { action: "search", phone: "+39 333 1234567" },
    },
    {
      label: "Crea nuovo contatto",
      input: { action: "create", firstName: "Mario", lastName: "Rossi", phone: "+39 333 1234567", email: "mario@example.com" },
    },
    {
      label: "Aggiorna telefono di un contatto esistente",
      input: { action: "update", contactId: "12345", phone: "+39 333 9876543" },
    },
    {
      label: "Crea contatto con custom property 'evento'",
      input: {
        action: "create",
        firstName: "Mario",
        lastName: "Rossi",
        phone: "+39 333 1234567",
        email: "mario@example.com",
        customProperties: { evento: "spring-conference-2026" },
      },
    },
    {
      label: "Cerca tutti i contatti di un evento",
      input: {
        action: "search",
        filters: [{ property: "evento", propertyName: null, operator: "EQ", value: "spring-conference-2026" }],
        returnProperties: ["evento"],
        limit: 100,
      },
    },
    {
      label: "Pagina successiva di una ricerca",
      input: {
        action: "search",
        filters: [{ property: "evento", propertyName: null, operator: "EQ", value: "spring-conference-2026" }],
        limit: 100,
        after: "<valore nextAfter della chiamata precedente>",
      },
    },
    {
      label: "Get-by-id (search per contactId)",
      input: { action: "search", contactId: "12345" },
    },
  ],
  parameters: z.object({
    action: z.enum(["create", "update", "search"]).describe("'create' per nuovo contatto, 'update' per aggiornare, 'search' per cercare"),
    contactId: z
      .string()
      .nullable()
      .describe(
        "ID contatto HubSpot. Obbligatorio per 'update'. " +
        "In 'search' è opzionale: se valorizzato equivale a un get-by-id (filtra per hs_object_id EQ).",
      ),
    firstName: z.string().nullable().describe("Nome"),
    lastName: z.string().nullable().describe("Cognome"),
    phone: z.string().nullable().describe("Numero di telefono"),
    email: z.string().nullable().describe("Email"),
    companyId: z
      .string()
      .nullable()
      .describe("ID azienda HubSpot da associare al contatto (opzionale per create)"),
    name: z
      .string()
      .nullable()
      .describe("Nome o cognome da cercare (solo per action 'search')"),
    customProperties: z
      .record(z.string(), z.string())
      .nullable()
      .describe(
        "Proprietà HubSpot arbitrarie da scrivere sul contatto (chiave = internal name property, valore = stringa). " +
        "Usare per popolare custom properties già definite nel portale (es. { evento: 'spring-conference-2026' }). " +
        "Non valido per action 'search'.",
      ),
    // NOTE: schema piano (property/propertyName entrambi nullable). Il coalescing
    // `property ?? propertyName` (con errore se mancano entrambi) è runtime in
    // execute — NON in schema — perché `.preprocess()`/`.transform()` che lancia
    // non è rappresentabile come JSON Schema statico (strict-mode). Il campo
    // `property` è quello canonico; `propertyName` (nome REST HubSpot) è accettato
    // per tolleranza verso i modelli. 
    filters: z
      .array(
        z.object({
          property: z.string().nullable(),
          propertyName: z.string().nullable(),
          operator: z.enum(HUBSPOT_FILTER_OPERATORS),
          value: z.string(),
        }),
      )
      .nullable()
      .describe(
        "Filtri aggiuntivi per action 'search'. Combinati in AND con phone/name/email se presenti, altrimenti formano un singolo filterGroup. " +
        "Il campo del filtro è `property` (l'alias `propertyName` è accettato per tolleranza). " +
        "Operatori supportati: EQ, NEQ, HAS_PROPERTY, NOT_HAS_PROPERTY, CONTAINS_TOKEN, GT, GTE, LT, LTE (solo operatori con value singolo — IN/NOT_IN non supportati). " +
        "Esempio: [{ property: 'evento', operator: 'EQ', value: 'spring-conference-2026' }]",
      ),
    returnProperties: z
      .array(z.string())
      .nullable()
      .describe(
        "Proprietà aggiuntive da includere nella response della action 'search' (es. ['evento']). " +
        "I valori verranno esposti nel campo 'customProperties' di ogni contatto. " +
        "Ignorato per create/update.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("Numero massimo di risultati per 'search' (default 10, max 100). Ignorato per create/update."),
    after: z
      .string()
      .nullable()
      .describe("Cursor di paginazione HubSpot per 'search'. Usare il valore 'nextAfter' della chiamata precedente."),
  }),
  execute: async (
    {
      action,
      contactId,
      firstName,
      lastName,
      phone,
      email,
      companyId,
      name,
      customProperties,
      filters,
      returnProperties,
      limit,
      after,
    }: {
      action: "create" | "update" | "search";
      contactId: string | null;
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
      email: string | null;
      companyId: string | null;
      name: string | null;
      customProperties: Record<string, string> | null;
      filters: Array<{ property: string | null; propertyName: string | null; operator: (typeof HUBSPOT_FILTER_OPERATORS)[number]; value: string }> | null;
      returnProperties: string[] | null;
      limit: number | null;
      after: string | null;
    },
    ctx: ToolContext,
  ) => {
    const apiKeyResult = getHubSpotApiKeyOrError(ctx);
    if (typeof apiKeyResult !== "string") return apiKeyResult;
    const apiKey = apiKeyResult;

    if (action === "search") {
      // Runtime coalescing of the property/propertyName alias (rule 7: moved out
      // of the schema transform). Fail closed with `{ error }` — never throw.
      const normalizedFilters: Array<{ property: string; operator: (typeof HUBSPOT_FILTER_OPERATORS)[number]; value: string }> = [];
      for (const f of filters ?? []) {
        const property = f.property ?? f.propertyName;
        if (!property) {
          return { error: "filters[].property è obbligatorio (puoi passarlo anche come 'propertyName')." };
        }
        normalizedFilters.push({ property, operator: f.operator, value: f.value });
      }
      return searchContacts(ctx, apiKey, {
        contactId,
        phone,
        name,
        email,
        filters: filters ? normalizedFilters : null,
        returnProperties,
        limit,
        after,
      });
    }

    return manageContact(ctx, apiKey, { action, contactId, firstName, lastName, phone, email, companyId, customProperties });
  },
});

async function searchContacts(
  ctx: ToolContext,
  apiKey: string,
  criteria: {
    contactId: string | null;
    phone: string | null;
    name: string | null;
    email: string | null;
    filters: Array<{ property: string; operator: (typeof HUBSPOT_FILTER_OPERATORS)[number]; value: string }> | null;
    returnProperties: string[] | null;
    limit: number | null;
    after: string | null;
  },
) {
  try {
    const filterGroups = buildFilterGroups(criteria);
    if (filterGroups.length === 0) {
      return { error: "Specifica almeno un criterio di ricerca: contactId, telefono, nome, email o filters." };
    }

    const baseProperties = ["firstname", "lastname", "phone", "mobilephone", "email", "hs_object_id", "hubspot_owner_id"];
    const extraProperties = criteria.returnProperties ?? [];
    const allProperties = Array.from(new Set([...baseProperties, ...extraProperties]));

    const effectiveLimit = Math.min(criteria.limit ?? 10, 100);

    const searchBody: Record<string, unknown> = {
      filterGroups,
      properties: allProperties,
      limit: effectiveLimit,
    };
    if (criteria.after) {
      searchBody.after = criteria.after;
    }

    const response = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(searchBody),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return { error: `HubSpot API error (${response.status}): ${body.slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      total: number;
      results: Array<{
        id: string;
        properties: Record<string, string | null>;
      }>;
      paging?: { next?: { after?: string } };
    };

    // Resolve owner ids → name/email so callers see "Mario Rossi" instead of a
    // numeric id. Only hit the Owners API when at least one result carries an
    // owner (resolveOwnerNames also short-circuits on an empty id list). The
    // portal-id and owner lookups are independent, so run them in parallel.
    const ownerIds = data.results
      .map((c) => c.properties.hubspot_owner_id)
      .filter((id): id is string => Boolean(id));
    const [portalId, owners] = await Promise.all([
      getHubSpotPortalId(apiKey),
      resolveOwnerNames(apiKey, ownerIds),
    ]);

    const result = {
      found: data.total,
      contacts: data.results.map((c) => {
        const customProperties: Record<string, string | null> = {};
        for (const key of extraProperties) {
          customProperties[key] = c.properties[key] ?? null;
        }
        const ownerId = c.properties.hubspot_owner_id ?? null;
        const owner = ownerId ? owners.get(ownerId) : undefined;
        return {
          id: c.id,
          firstName: c.properties.firstname ?? null,
          lastName: c.properties.lastname ?? null,
          phone: c.properties.phone ?? c.properties.mobilephone ?? null,
          email: c.properties.email ?? null,
          url: hubspotUrl(portalId, "contact", c.id),
          // hubspot_owner_id is retained for backward compatibility; owner_name
          // and owner_email are added only when the owner could be resolved.
          ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
          ...(owner ? { owner_name: owner.name, owner_email: owner.email } : {}),
          ...(extraProperties.length > 0 ? { customProperties } : {}),
        };
      }),
      ...(data.paging?.next?.after ? { nextAfter: data.paging.next.after } : {}),
    };

    ctx.audit.log({
      action: "crm.searchContacts",
      details: {
        ...(criteria.contactId ? { contactId: criteria.contactId } : {}),
        ...(criteria.phone ? { phone: auditPreview(criteria.phone) } : {}),
        ...(criteria.name ? { name: auditPreview(criteria.name) } : {}),
        ...(criteria.email ? { email: auditPreview(criteria.email) } : {}),
        ...(criteria.filters && criteria.filters.length > 0
          ? { customFilterProperties: criteria.filters.map((f) => f.property) }
          : {}),
        resultCount: data.total,
      },
      success: true,
    });

    return result;
  } catch (err) {
    ctx.audit.log({
      action: "crm.searchContacts",
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot search failed: ${errMsg(err)}` };
  }
}

function buildFilterGroups(criteria: {
  contactId: string | null;
  phone: string | null;
  name: string | null;
  email: string | null;
  filters: Array<{ property: string; operator: (typeof HUBSPOT_FILTER_OPERATORS)[number]; value: string }> | null;
}): Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> {
  const groups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> = [];

  if (criteria.contactId) {
    groups.push({
      filters: [{ propertyName: "hs_object_id", operator: "EQ", value: criteria.contactId }],
    });
  }

  if (criteria.phone) {
    groups.push(...buildPhoneFilterGroups(criteria.phone));
  }

  if (criteria.name) {
    const parts = criteria.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      groups.push({
        filters: [
          { propertyName: "firstname", operator: "CONTAINS_TOKEN", value: parts[0] },
          { propertyName: "lastname", operator: "CONTAINS_TOKEN", value: parts.slice(1).join(" ") },
        ],
      });
    } else {
      groups.push({
        filters: [{ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: parts[0] }],
      });
      groups.push({
        filters: [{ propertyName: "lastname", operator: "CONTAINS_TOKEN", value: parts[0] }],
      });
    }
  }

  if (criteria.email) {
    groups.push({
      filters: [{ propertyName: "email", operator: "EQ", value: criteria.email }],
    });
  }

  // Normalize custom filters to HubSpot shape
  const extraFilters = (criteria.filters ?? []).map((f) => ({
    propertyName: f.property,
    operator: f.operator,
    value: f.value,
  }));

  if (extraFilters.length > 0) {
    if (groups.length === 0) {
      // Standalone: single filterGroup with all filters AND-ed together
      groups.push({ filters: extraFilters });
    } else {
      // Combine: AND the custom filters into every existing group
      for (const g of groups) {
        g.filters.push(...extraFilters);
      }
    }
  }

  return groups;
}


async function manageContact(
  ctx: ToolContext,
  apiKey: string,
  params: {
    action: "create" | "update";
    contactId: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
    companyId: string | null;
    customProperties: Record<string, string> | null;
  },
) {
  const { action, contactId, firstName, lastName, phone, email, companyId, customProperties } = params;

  if (action === "update" && !contactId) {
    return { error: "contactId obbligatorio per l'azione 'update'." };
  }

  // Basic email format validation
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (email && !EMAIL_RE.test(email)) {
    return { error: `Formato email non valido: '${email}'.` };
  }

  try {
    const properties: Record<string, string> = {};
    if (firstName) properties.firstname = firstName;
    if (lastName) properties.lastname = lastName;
    if (phone) properties.phone = phone;
    if (email) properties.email = email;
    if (customProperties) {
      for (const [key, value] of Object.entries(customProperties)) {
        properties[key] = value;
      }
    }

    if (Object.keys(properties).length === 0) {
      return { error: "Specifica almeno una proprieta' (firstName, lastName, phone, email, customProperties)." };
    }

    let url: string;
    let method: string;

    if (action === "create") {
      url = "https://api.hubapi.com/crm/v3/objects/contacts";
      method = "POST";
    } else {
      url = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`;
      method = "PATCH";
    }

    const response = await hubspotFetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ properties }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { error: `HubSpot API error (${response.status}): ${body.slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const warnings: string[] = [];

    // Associate with company (type 1 = contact-to-company) — only on create
    if (companyId && action === "create") {
      const assocRes = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/contacts/companies/batch/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: [
              {
                from: { id: data.id },
                to: { id: companyId },
                type: HUBSPOT_ASSOCIATION_TYPES.contactToCompany,
              },
            ],
          }),
        },
      );

      if (!assocRes.ok) {
        const body = await assocRes.text();
        warnings.push(`Associazione azienda fallita: ${body.slice(0, 100)}`);
      }
    }

    const portalId = await getHubSpotPortalId(apiKey);

    const result = {
      success: true,
      action,
      contact: {
        id: data.id,
        firstName: data.properties.firstname ?? null,
        lastName: data.properties.lastname ?? null,
        phone: data.properties.phone ?? null,
        email: data.properties.email ?? null,
        url: hubspotUrl(portalId, "contact", data.id),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    ctx.audit.log({
      action: action === "create" ? "crm.createContact" : "crm.updateContact",
      details: {
        contactId: data.id,
        fieldsChanged: Object.keys(properties),
        companyId: companyId ?? undefined,
        ...(customProperties ? { customPropertyKeys: Object.keys(customProperties) } : {}),
      },
      success: true,
    });

    return result;
  } catch (err) {
    ctx.audit.log({
      action: action === "create" ? "crm.createContact" : "crm.updateContact",
      details: { ...(contactId ? { contactId } : {}) },
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot ${action} failed: ${errMsg(err)}` };
  }
}
