// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import type { ToolContext } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../lib/error.js";
import { auditPreview } from "../lib/audit-preview.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES } from "../lib/hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "../lib/hubspot-portal.js";

export default defineTool({
  name: "deal",
  description:
    "Gestisce i deal nel CRM HubSpot: crea, aggiorna o cerca deal (opportunita').\n" +
    "Usa con action 'create' per nuovi deal, 'update' per aggiornare deal esistenti, 'search' per cercare.\n" +
    "NON usare per creare contatti — usa hubspot__contact con action 'create'.\n" +
    "Restituisce ID del deal e URL nel portale HubSpot.\n" +
    "Caveat: per 'create', stage deve corrispondere a una pipeline stage valida. contactId e companyId sono opzionali per l'associazione. Per 'update', dealId è obbligatorio — puoi aggiornare stage, amount, closeDate, description. Per 'search', closeDateAfter/Before filtrano sulla data di chiusura prevista, NON sulla data di creazione. Il parametro opzionale associatedContactId filtra i deal di uno specifico contatto — utile per trovare lo storico acquisti di un cliente esistente. Per leggere custom properties del portale passa returnProperties (es. ['plan_tier','sla_class']) — i valori vengono esposti in customProperties di ogni deal. Stages: appointmentscheduled, qualifiedtobuy, presentationscheduled, decisionmakerboughtin, closedwon, closedlost.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Deal minimo",
      input: { action: "create", dealName: "Rinnovo servizio - Acme Srl", stage: "appointmentscheduled" },
    },
    {
      label: "Deal completo con associazioni",
      input: { action: "create", dealName: "Upgrade Premium", stage: "qualifiedtobuy", amount: 5000, closeDate: "2026-06-30", contactId: "12345", companyId: "67890" },
    },
    {
      label: "Aggiorna stage di un deal",
      input: { action: "update", dealId: "496624375027", stage: "decisionmakerboughtin" },
    },
    {
      label: "Tutti i deal attivi (panoramica)",
      input: { action: "search" },
    },
    {
      label: "Deal in fase qualificata con close date",
      input: { action: "search", stage: "qualifiedtobuy", closeDateAfter: "2026-04-01", closeDateBefore: "2026-06-30" },
    },
    {
      label: "Deal di un contatto con custom properties",
      input: { action: "search", associatedContactId: "12345", stage: "closedwon", returnProperties: ["plan_tier", "sla_class"], limit: 1 },
    },
  ],
  parameters: z.object({
    action: z.enum(["create", "update", "search"]).describe("'create' per nuovo deal, 'update' per aggiornare un deal esistente, 'search' per cercare"),
      // --- update params ---
      dealId: z
        .string()
        .nullable()
        .describe("ID del deal HubSpot da aggiornare (obbligatorio per update)"),
      // --- create params ---
      dealName: z
        .string()
        .nullable()
        .describe("Nome del deal (obbligatorio per create, es. 'Renewal Fibra 10Gbps - Acme Srl')"),
      stage: z
        .string()
        .nullable()
        .describe("Stage del pipeline (obbligatorio per create, es. 'appointmentscheduled', 'qualifiedtobuy', 'closedwon')"),
      pipeline: z
        .string()
        .nullable()
        .describe("Pipeline ID. Se null, usa il pipeline di default."),
      amount: z
        .number()
        .nullable()
        .describe("Valore del deal in EUR"),
      closeDate: z
        .string()
        .nullable()
        .describe("Data chiusura prevista (ISO 8601). Se null, non impostata."),
      contactId: z
        .string()
        .nullable()
        .describe("ID contatto HubSpot da associare al deal"),
      companyId: z
        .string()
        .nullable()
        .describe("ID azienda HubSpot da associare al deal"),
      description: z
        .string()
        .nullable()
        .describe("Note o descrizione del deal"),
      // --- search params ---
      query: z
        .string()
        .nullable()
        .describe("Testo libero da cercare nel nome del deal (solo per search)"),
      closeDateAfter: z
        .string()
        .nullable()
        .describe("Data chiusura dopo questa data (ISO 8601, solo per search)"),
      closeDateBefore: z
        .string()
        .nullable()
        .describe("Data chiusura prima di questa data (ISO 8601, solo per search)"),
      createdAfter: z
        .string()
        .nullable()
        .describe("Creato dopo questa data (ISO 8601, solo per search)"),
      limit: z
        .number()
        .nullable()
        .describe("Numero massimo di risultati (default 20, max 100, solo per search)"),
      associatedContactId: z
        .string()
        .nullable()
        .describe("Filtra i deal associati a questo contactId HubSpot (solo per search). Usa per trovare lo storico acquisti di un cliente esistente."),
      returnProperties: z
        .array(z.string())
        .nullable()
        .describe(
          "Proprietà aggiuntive da includere nella response della action 'search' (es. ['plan_tier','sla_class']). " +
          "I valori verranno esposti nel campo 'customProperties' di ogni deal. " +
          "Ignorato per create/update.",
        ),
    }),
  execute: async (
    params: {
      action: "create" | "update" | "search";
      dealId: string | null;
      dealName: string | null;
      stage: string | null;
      pipeline: string | null;
      amount: number | null;
      closeDate: string | null;
      contactId: string | null;
      companyId: string | null;
      description: string | null;
      query: string | null;
      closeDateAfter: string | null;
      closeDateBefore: string | null;
      createdAfter: string | null;
      limit: number | null;
      associatedContactId: string | null;
      returnProperties: string[] | null;
    },
    ctx: ToolContext,
  ) => {
    const apiKeyResult = getHubSpotApiKeyOrError(ctx);
    if (typeof apiKeyResult !== "string") return apiKeyResult;
    const apiKey = apiKeyResult;

    if (params.action === "search") {
      return searchDeals(ctx, apiKey, params);
    }

    if (params.action === "update") {
      return updateDeal(ctx, apiKey, params);
    }

    return createDeal(ctx, apiKey, params);
  },
});

async function createDeal(
  ctx: ToolContext,
  apiKey: string,
  params: {
    dealName: string | null;
    stage: string | null;
    pipeline: string | null;
    amount: number | null;
    closeDate: string | null;
    contactId: string | null;
    companyId: string | null;
    description: string | null;
  },
) {
  if (!params.dealName || !params.stage) {
    return { error: "dealName e stage sono obbligatori per l'azione 'create'." };
  }

  try {
    // 1. Create the deal
    const properties: Record<string, string> = {
      dealname: params.dealName,
      dealstage: params.stage,
    };

    if (params.pipeline) properties.pipeline = params.pipeline;
    if (params.amount != null) properties.amount = String(params.amount);
    if (params.closeDate) properties.closedate = params.closeDate;
    if (params.description) properties.description = params.description;

    const createResponse = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/deals",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ properties }),
      },
    );

    if (!createResponse.ok) {
      const respBody = await createResponse.text();
      return { error: `Errore creazione deal (${createResponse.status}): ${respBody.slice(0, 200)}` };
    }

    const deal = (await createResponse.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const warnings: string[] = [];

    // 2. Associate with contact (type 3 = deal-to-contact)
    if (params.contactId) {
      const assocRes = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/deals/contacts/batch/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: [
              {
                from: { id: deal.id },
                to: { id: params.contactId },
                type: HUBSPOT_ASSOCIATION_TYPES.dealToContact,
              },
            ],
          }),
        },
      );

      if (!assocRes.ok) {
        const body = await assocRes.text();
        warnings.push(`Associazione contatto fallita: ${body.slice(0, 100)}`);
      }
    }

    // 3. Associate with company (type 5 = deal-to-company)
    if (params.companyId) {
      const assocRes = await hubspotFetch(
        "https://api.hubapi.com/crm/v3/associations/deals/companies/batch/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: [
              {
                from: { id: deal.id },
                to: { id: params.companyId },
                type: HUBSPOT_ASSOCIATION_TYPES.dealToCompany,
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

    ctx.audit.log({
      action: "crm.createDeal",
      details: {
        dealId: deal.id,
        dealName: auditPreview(params.dealName),
        stage: params.stage,
        amount: params.amount,
        contactId: params.contactId,
        companyId: params.companyId,
      },
      success: true,
    });

    const portalId = await getHubSpotPortalId(apiKey);

    return {
      success: true,
      deal: {
        id: deal.id,
        name: params.dealName,
        stage: params.stage,
        amount: params.amount,
        url: hubspotUrl(portalId, "deal", deal.id),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      message: "Deal creato con successo.",
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.createDeal",
      details: { dealName: auditPreview(params.dealName!) },
      success: false,
      error: errMsg(err),
    });
    return { error: `Errore creazione deal: ${errMsg(err)}` };
  }
}

// ---------------------------------------------------------------------------
// update logic
// ---------------------------------------------------------------------------

async function updateDeal(
  ctx: ToolContext,
  apiKey: string,
  params: {
    dealId: string | null;
    dealName: string | null;
    stage: string | null;
    amount: number | null;
    closeDate: string | null;
    description: string | null;
    pipeline: string | null;
  },
) {
  if (!params.dealId) {
    return { error: "dealId è obbligatorio per l'azione 'update'." };
  }

  try {
    const properties: Record<string, string> = {};
    if (params.dealName) properties.dealname = params.dealName;
    if (params.stage) properties.dealstage = params.stage;
    if (params.pipeline) properties.pipeline = params.pipeline;
    if (params.amount != null) properties.amount = String(params.amount);
    if (params.closeDate) properties.closedate = params.closeDate;
    if (params.description) properties.description = params.description;

    if (Object.keys(properties).length === 0) {
      return { error: "Specifica almeno un campo da aggiornare (stage, amount, closeDate, description, dealName)." };
    }

    const response = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${params.dealId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ properties }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return { error: `Errore aggiornamento deal (${response.status}): ${body.slice(0, 200)}` };
    }

    const deal = (await response.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    const portalId = await getHubSpotPortalId(apiKey);

    ctx.audit.log({
      action: "crm.updateDeal",
      details: {
        dealId: params.dealId,
        updatedFields: Object.keys(properties),
      },
      success: true,
    });

    return {
      success: true,
      deal: {
        id: deal.id,
        name: deal.properties.dealname,
        stage: deal.properties.dealstage,
        amount: deal.properties.amount,
        closeDate: deal.properties.closedate,
        url: hubspotUrl(portalId, "deal", deal.id),
      },
      message: "Deal aggiornato con successo.",
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.updateDeal",
      details: { dealId: params.dealId },
      success: false,
      error: errMsg(err),
    });
    return { error: `Errore aggiornamento deal: ${errMsg(err)}` };
  }
}

async function searchDeals(
  ctx: ToolContext,
  apiKey: string,
  params: {
    query: string | null;
    stage: string | null;
    closeDateAfter: string | null;
    closeDateBefore: string | null;
    createdAfter: string | null;
    limit: number | null;
    associatedContactId: string | null;
    returnProperties: string[] | null;
  },
) {
  try {
    const filters: Array<{ propertyName: string; operator: string; value: string }> = [];

    if (params.stage) {
      filters.push({ propertyName: "dealstage", operator: "EQ", value: params.stage });
    }
    if (params.closeDateAfter) {
      filters.push({ propertyName: "closedate", operator: "GTE", value: params.closeDateAfter });
    }
    if (params.closeDateBefore) {
      filters.push({ propertyName: "closedate", operator: "LTE", value: params.closeDateBefore });
    }
    if (params.createdAfter) {
      filters.push({ propertyName: "createdate", operator: "GTE", value: params.createdAfter });
    }
    if (params.associatedContactId) {
      filters.push({ propertyName: "associations.contact", operator: "EQ", value: params.associatedContactId });
    }

    const baseProperties = [
      "dealname",
      "amount",
      "dealstage",
      "closedate",
      "createdate",
      "hs_lastmodifieddate",
      "description",
    ];
    const extraProperties = params.returnProperties ?? [];
    const allProperties = Array.from(new Set([...baseProperties, ...extraProperties]));

    const searchBody: Record<string, unknown> = {
      properties: allProperties,
      limit: Math.min(params.limit ?? 20, 100),
    };

    if (filters.length > 0) {
      searchBody.filterGroups = [{ filters }];
    }

    if (params.query) {
      searchBody.query = params.query;
    }

    const response = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/deals/search",
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
    };

    const portalId = await getHubSpotPortalId(apiKey);

    const result = {
      found: data.total,
      deals: data.results.map((d) => {
        const customProperties: Record<string, string | null> = {};
        for (const key of extraProperties) {
          customProperties[key] = d.properties[key] ?? null;
        }
        return {
          id: d.id,
          name: d.properties.dealname,
          amount: d.properties.amount,
          stage: d.properties.dealstage,
          closeDate: d.properties.closedate,
          createdAt: d.properties.createdate,
          lastModified: d.properties.hs_lastmodifieddate,
          description: d.properties.description,
          url: hubspotUrl(portalId, "deal", d.id),
          ...(extraProperties.length > 0 ? { customProperties } : {}),
        };
      }),
    };

    ctx.audit.log({
      action: "crm.searchDeals",
      details: {
        ...(params.query ? { query: auditPreview(params.query) } : {}),
        ...(params.stage ? { stage: params.stage } : {}),
        resultCount: data.total,
      },
      success: true,
    });

    return result;
  } catch (err) {
    ctx.audit.log({
      action: "crm.searchDeals",
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot deal search failed: ${errMsg(err)}` };
  }
}
