// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import type { ToolContext } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../lib/error.js";
import { auditPreview } from "../lib/audit-preview.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES } from "../lib/hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "../lib/hubspot-portal.js";

export default defineTool({
  name: "meeting",
  description:
    "Gestisce gli appuntamenti (meeting) nel CRM HubSpot: crea, recupera o aggiorna meeting.\n" +
    "Usa con action 'create' per nuovi appuntamenti, 'get' per recuperare quelli di un contatto, 'update' per modificarli.\n" +
    "Restituisce ID del meeting e URL nel portale HubSpot.\n" +
    "Caveat: per 'create', startTime e endTime in formato ISO 8601, contactId obbligatorio. Per 'get', mostra appuntamenti futuri e quelli degli ultimi 30 giorni. Per 'update', solo le proprieta' passate vengono aggiornate.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Crea appuntamento",
      input: { action: "create", contactId: "12345", title: "Consulenza iniziale", startTime: "2026-04-15T10:00:00.000Z", endTime: "2026-04-15T10:30:00.000Z" },
    },
    {
      label: "Recupera appuntamenti di un contatto",
      input: { action: "get", contactId: "12345" },
    },
    {
      label: "Aggiorna esito meeting",
      input: {
        action: "update",
        meetingId: "67890",
        properties: {
          hs_meeting_outcome: "COMPLETED",
          hs_meeting_start_time: null,
          hs_meeting_end_time: null,
          hs_meeting_title: null,
        },
      },
    },
  ],
  parameters: z.object({
    action: z.enum(["create", "get", "update"]).describe("'create' per nuovo meeting, 'get' per recuperare, 'update' per aggiornare"),
      // --- create params ---
      contactId: z
        .string()
        .nullable()
        .describe("ID del contatto HubSpot (obbligatorio per create e get)"),
      title: z
        .string()
        .nullable()
        .describe("Titolo dell'appuntamento (obbligatorio per create)"),
      startTime: z
        .union([z.string(), z.number()])
        .nullable()
        .describe("Data e ora inizio: stringa ISO 8601 oppure millisecondi epoch (obbligatorio per create)"),
      endTime: z
        .union([z.string(), z.number()])
        .nullable()
        .describe("Data e ora fine: stringa ISO 8601 oppure millisecondi epoch (obbligatorio per create)"),
      description: z
        .string()
        .nullable()
        .describe("Descrizione o note sull'appuntamento (solo per create)"),
      location: z
        .string()
        .nullable()
        .describe("Sede dell'appuntamento (solo per create)"),
      // --- update params ---
      meetingId: z
        .string()
        .nullable()
        .describe("ID del meeting HubSpot da aggiornare (obbligatorio per update)"),
      properties: z.object({
        hs_meeting_outcome: z
          .string()
          .nullable()
          .describe("Esito del meeting (es. 'COMPLETED', 'CANCELED', 'RESCHEDULED', 'NO_SHOW')"),
        hs_meeting_start_time: z
          .string()
          .nullable()
          .describe("Data/ora inizio in formato ISO 8601"),
        hs_meeting_end_time: z
          .string()
          .nullable()
          .describe("Data/ora fine in formato ISO 8601"),
        hs_meeting_title: z
          .string()
          .nullable()
          .describe("Titolo del meeting"),
      }).nullable().describe("Proprietà del meeting da aggiornare (solo per update)"),
    }),
  execute: async (
    params: {
      action: "create" | "get" | "update";
      contactId: string | null;
      title: string | null;
      startTime: string | number | null;
      endTime: string | number | null;
      description: string | null;
      location: string | null;
      meetingId: string | null;
      properties: {
        hs_meeting_outcome: string | null;
        hs_meeting_start_time: string | null;
        hs_meeting_end_time: string | null;
        hs_meeting_title: string | null;
      } | null;
    },
    ctx: ToolContext,
  ) => {
    const apiKeyResult = getHubSpotApiKeyOrError(ctx);
    if (typeof apiKeyResult !== "string") return apiKeyResult;
    const apiKey = apiKeyResult;

    if (params.action === "get") {
      if (!params.contactId) {
        return { error: "contactId obbligatorio per l'azione 'get'." };
      }
      return getMeetings(ctx, apiKey, params.contactId);
    }

    if (params.action === "update") {
      if (!params.meetingId) {
        return { error: "meetingId obbligatorio per l'azione 'update'." };
      }
      return updateMeeting(ctx, apiKey, params.meetingId, params.properties);
    }

    return createMeeting(ctx, apiKey, params);
  },
});

async function createMeeting(
  ctx: ToolContext,
  apiKey: string,
  params: {
    contactId: string | null;
    title: string | null;
    startTime: string | number | null;
    endTime: string | number | null;
    description: string | null;
    location: string | null;
  },
) {
  if (!params.contactId || !params.title || params.startTime == null || params.endTime == null) {
    return { error: "contactId, title, startTime e endTime sono obbligatori per l'azione 'create'." };
  }

  const { contactId, title, startTime, endTime, description, location } = params;

  try {
    // Validate timestamps — accept ISO 8601 strings or millisecond epoch numbers
    const start = typeof startTime === "number" ? new Date(startTime) : new Date(startTime);
    const end = typeof endTime === "number" ? new Date(endTime) : new Date(endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { error: "Formato data/ora non valido. Usa ISO 8601 (es. 2026-03-20T10:00:00) oppure millisecondi epoch." };
    }
    if (end <= start) {
      return { error: "L'ora di fine deve essere successiva all'ora di inizio." };
    }

    // 1. Create the meeting engagement
    const meetingProperties: Record<string, string> = {
      hs_timestamp: start.toISOString(),
      hs_meeting_title: title,
      hs_meeting_start_time: start.toISOString(),
      hs_meeting_end_time: end.toISOString(),
      hs_meeting_outcome: "SCHEDULED",
    };

    if (description) meetingProperties.hs_meeting_body = description;
    if (location) meetingProperties.hs_meeting_location = location;

    const createResponse = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/meetings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ properties: meetingProperties }),
      },
    );

    if (!createResponse.ok) {
      const body = await createResponse.text();
      return { error: `Errore creazione meeting (${createResponse.status}): ${body.slice(0, 200)}` };
    }

    const meeting = (await createResponse.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    // 2. Associate meeting with contact (batch endpoint, type 200)
    const assocResponse = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/associations/meetings/contacts/batch/create",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          inputs: [
            {
              from: { id: meeting.id },
              to: { id: contactId },
              type: HUBSPOT_ASSOCIATION_TYPES.meetingToContact,
            },
          ],
        }),
      },
    );

    if (!assocResponse.ok) {
      // Meeting created but association failed — report partial success
      const body = await assocResponse.text();

      ctx.audit.log({
        action: "crm.createMeeting",
        details: {
          meetingId: meeting.id,
          title: auditPreview(title),
          startTime: start.toISOString(),
          contactId,
          warning: "association failed",
        },
        success: true,
      });

      return {
        success: true,
        warning: `Meeting creato (ID: ${meeting.id}) ma associazione al contatto fallita: ${body.slice(0, 200)}`,
        meeting: {
          id: meeting.id,
          title,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          location: location ?? null,
        },
      };
    }

    ctx.audit.log({
      action: "crm.createMeeting",
      details: {
        meetingId: meeting.id,
        title: auditPreview(title),
        startTime: start.toISOString(),
        contactId,
      },
      success: true,
    });

    const portalId = await getHubSpotPortalId(apiKey);

    return {
      success: true,
      meeting: {
        id: meeting.id,
        title,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        location: location ?? null,
        contactUrl: hubspotUrl(portalId, "contact", contactId),
      },
      message: `Appuntamento creato con successo per ${start.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })} alle ${start.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.`,
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.createMeeting",
      details: { contactId },
      success: false,
      error: errMsg(err),
    });
    return { error: `Errore creazione appuntamento: ${errMsg(err)}` };
  }
}

async function getMeetings(
  ctx: ToolContext,
  apiKey: string,
  contactId: string,
) {
  try {
    // 1. Get meeting associations for the contact
    const assocResponse = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/meetings`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (!assocResponse.ok) {
      const body = await assocResponse.text();
      return { error: `Errore recupero associazioni meeting (${assocResponse.status}): ${body.slice(0, 200)}` };
    }

    const assocData = (await assocResponse.json()) as {
      results: Array<{ id: string; type: string }>;
    };

    if (!assocData.results || assocData.results.length === 0) {
      return { found: 0, meetings: [], message: "Nessun appuntamento trovato per questo contatto." };
    }

    // 2. Batch read meeting details
    const meetingIds = assocData.results.map((r) => ({ id: r.id }));

    const batchResponse = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/meetings/batch/read",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          inputs: meetingIds,
          properties: [
            "hs_meeting_title",
            "hs_meeting_start_time",
            "hs_meeting_end_time",
            "hs_meeting_outcome",
            "hs_meeting_location",
          ],
        }),
      },
    );

    if (!batchResponse.ok) {
      const body = await batchResponse.text();
      return { error: `Errore recupero dettagli meeting (${batchResponse.status}): ${body.slice(0, 200)}` };
    }

    const batchData = (await batchResponse.json()) as {
      results: Array<{
        id: string;
        properties: Record<string, string | null>;
      }>;
    };

    // 3. Filter: future meetings + meetings from last 30 days
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const dateFormatter = new Intl.DateTimeFormat("it-IT", {
      timeZone: "Europe/Rome",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const timeFormatter = new Intl.DateTimeFormat("it-IT", {
      timeZone: "Europe/Rome",
      hour: "2-digit",
      minute: "2-digit",
    });

    const portalId = await getHubSpotPortalId(apiKey);

    const filtered = batchData.results
      .filter((m) => {
        const startTime = m.properties.hs_meeting_start_time;
        if (!startTime) return false;
        const start = new Date(startTime);
        // Future meetings OR meetings from last 30 days
        return start > thirtyDaysAgo;
      })
      .map((m) => {
        const startDate = new Date(m.properties.hs_meeting_start_time!);
        const endDate = m.properties.hs_meeting_end_time
          ? new Date(m.properties.hs_meeting_end_time)
          : null;

        return {
          id: m.id,
          title: m.properties.hs_meeting_title ?? "Senza titolo",
          date: dateFormatter.format(startDate),
          startTime: timeFormatter.format(startDate),
          endTime: endDate ? timeFormatter.format(endDate) : null,
          location: m.properties.hs_meeting_location ?? null,
          outcome: m.properties.hs_meeting_outcome ?? null,
          isFuture: startDate > now,
        };
      })
      .sort((a, b) => {
        // Sort by date: future first (ascending), then past (descending)
        if (a.isFuture && !b.isFuture) return -1;
        if (!a.isFuture && b.isFuture) return 1;
        return 0;
      });

    ctx.audit.log({
      action: "crm.getMeetings",
      details: {
        contactId,
        resultCount: filtered.length,
      },
      success: true,
    });

    return {
      found: filtered.length,
      meetings: filtered,
      contactUrl: hubspotUrl(portalId, "contact", contactId),
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.getMeetings",
      details: { contactId },
      success: false,
      error: errMsg(err),
    });
    return { error: `Errore recupero appuntamenti: ${errMsg(err)}` };
  }
}

async function updateMeeting(
  ctx: ToolContext,
  apiKey: string,
  meetingId: string,
  properties: {
    hs_meeting_outcome: string | null;
    hs_meeting_start_time: string | null;
    hs_meeting_end_time: string | null;
    hs_meeting_title: string | null;
  } | null,
) {
  // Filter out null values — only send fields the LLM explicitly set
  const filteredProperties: Record<string, string> = {};
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (value != null) {
        filteredProperties[key] = value;
      }
    }
  }

  if (Object.keys(filteredProperties).length === 0) {
    return {
      error:
        "Specifica almeno una proprietà da aggiornare " +
        "(hs_meeting_outcome, hs_meeting_start_time, hs_meeting_end_time, hs_meeting_title).",
    };
  }

  try {
    const url = `https://api.hubapi.com/crm/v3/objects/meetings/${meetingId}`;

    const response = await hubspotFetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ properties: filteredProperties }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { error: `HubSpot API error (${response.status}): ${body.slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      id: string;
      properties: Record<string, string | null>;
    };

    ctx.audit.log({
      action: "crm.updateMeeting",
      details: {
        meetingId,
        updatedFields: Object.keys(filteredProperties),
      },
      success: true,
    });

    return {
      success: true,
      meeting: {
        id: data.id,
        title: data.properties.hs_meeting_title ?? null,
        outcome: data.properties.hs_meeting_outcome ?? null,
        startTime: data.properties.hs_meeting_start_time ?? null,
        endTime: data.properties.hs_meeting_end_time ?? null,
      },
    };
  } catch (err) {
    ctx.audit.log({
      action: "crm.updateMeeting",
      details: { meetingId },
      success: false,
      error: errMsg(err),
    });
    return { error: `HubSpot update meeting failed: ${errMsg(err)}` };
  }
}
