// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../lib/error.js";
import { auditPreview } from "../lib/audit-preview.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES, resolveOwnerIdFromEmail } from "../lib/hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "../lib/hubspot-portal.js";
import { ensureHtmlBody } from "../lib/hubspot-rich-text.js";

export default defineTool({
  name: "createTask",
  description:
    "Crea un task nel CRM HubSpot e lo associa a un contatto.\n" +
    "Usa per registrare attivita' da completare: richieste di richiamata, follow-up, task operativi.\n" +
    "NON usare per creare note — usa hubspotNote.\n" +
    "NON usare per creare appuntamenti — usa hubspotMeeting.\n" +
    "Restituisce ID del task creato e URL nel portale HubSpot.\n" +
    "Caveat: dueDate e' opzionale ma consigliato. La priority accetta valori HubSpot standard (HIGH, MEDIUM, LOW).\n" +
    "Owner: per assegnare il task a un utente HubSpot specifico passa ownerEmail (es. 'mario.rossi@acme.net') o, se conosci direttamente il numeric id, ownerId. Se entrambi null il task è creato senza owner.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Task di richiamata",
      input: { contactId: "12345", subject: "Richiamata richiesta", body: "Il contatto ha chiesto di essere richiamato alle 15", priority: "HIGH", dueDate: "2026-04-10" },
    },
    {
      label: "Task assegnato a un owner specifico via email",
      input: { contactId: "12345", subject: "Revisione lead", body: "Punti fuori policy da revisionare", priority: "HIGH", dueDate: "2026-04-12", ownerEmail: "mario.rossi@acme.net" },
    },
  ],
  parameters: z.object({
      contactId: z
        .string()
        .describe("ID del contatto HubSpot a cui associare il task"),
      subject: z
        .string()
        .describe(
          "Oggetto del task (es. 'Richiamata - Mario Rossi')",
        ),
      body: z
        .string()
        .nullable()
        .describe(
          "Descrizione dettagliata: motivo della richiamata e riassunto conversazione",
        ),
      priority: z
        .enum(["LOW", "MEDIUM", "HIGH"])
        .describe("Priorita' del task"),
      dueDate: z
        .string()
        .nullable()
        .describe("Data di scadenza ISO 8601. Se null, impostata a oggi."),
      ownerEmail: z
        .string()
        .nullable()
        .describe(
          "Email dell'utente HubSpot a cui assegnare il task (es. 'mario.rossi@acme.net). " +
          "Il tool risolve internamente l'email in `hubspot_owner_id`. " +
          "Se non risolve, il task viene creato senza owner e viene aggiunto un warning. " +
          "Se è valorizzato anche `ownerId`, `ownerId` prevale.",
        ),
      ownerId: z
        .string()
        .nullable()
        .describe(
          "ID numerico HubSpot dell'owner (alternativa a ownerEmail, se lo conosci direttamente). " +
          "Prevale su ownerEmail se entrambi sono passati.",
        ),
    }),
  execute: async ({
      contactId,
      subject,
      body,
      priority,
      dueDate,
      ownerEmail,
      ownerId,
    }: {
      contactId: string;
      subject: string;
      body: string | null;
      priority: "LOW" | "MEDIUM" | "HIGH";
      dueDate: string | null;
      ownerEmail: string | null;
      ownerId: string | null;
    }, ctx) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      try {
        const timestamp = dueDate ? new Date(dueDate) : new Date();
        if (isNaN(timestamp.getTime())) {
          return {
            error:
              "Formato data non valido. Usa ISO 8601 (es. 2026-03-20T10:00:00).",
          };
        }

        // Resolve owner: ownerId prevails, else lookup by ownerEmail.
        // If resolution fails, we still create the task but flag a warning
        // in the response (owner-less task is recoverable; failing the
        // whole call would mask the more important task body).
        let resolvedOwnerId: string | null = ownerId;
        let ownerWarning: string | null = null;
        if (!resolvedOwnerId && ownerEmail) {
          resolvedOwnerId = await resolveOwnerIdFromEmail(apiKey, ownerEmail);
          if (!resolvedOwnerId) {
            ownerWarning = `Owner HubSpot non trovato per email "${ownerEmail}" — task creato senza owner.`;
          }
        }

        // 1. Create the task
        const taskProperties: Record<string, string> = {
          hs_task_subject: subject,
          hs_task_priority: priority,
          hs_timestamp: timestamp.toISOString(),
          hs_task_status: "NOT_STARTED",
          hs_task_type: "CALL",
        };
        if (resolvedOwnerId) {
          taskProperties.hubspot_owner_id = resolvedOwnerId;
        }

        // HubSpot renders task body as HTML. Auto-convert plain-text
        // newlines to <br> so LLM-emitted bodies stay readable.
        if (body) taskProperties.hs_task_body = ensureHtmlBody(body);

        const createResponse = await hubspotFetch(
          "https://api.hubapi.com/crm/v3/objects/tasks",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ properties: taskProperties }),
          },
        );

        if (!createResponse.ok) {
          const respBody = await createResponse.text();
          return {
            error: `Errore creazione task (${createResponse.status}): ${respBody.slice(0, 200)}`,
          };
        }

        const task = (await createResponse.json()) as {
          id: string;
          properties: Record<string, string | null>;
        };

        // 2. Associate task with contact (type 204 = task-to-contact)
        const assocResponse = await hubspotFetch(
          "https://api.hubapi.com/crm/v3/associations/tasks/contacts/batch/create",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              inputs: [
                {
                  from: { id: task.id },
                  to: { id: contactId },
                  type: HUBSPOT_ASSOCIATION_TYPES.taskToContact,
                },
              ],
            }),
          },
        );

        if (!assocResponse.ok) {
          const respBody = await assocResponse.text();
          return {
            success: true,
            warning: `Task creato (ID: ${task.id}) ma associazione al contatto fallita: ${respBody.slice(0, 200)}`,
            task: { id: task.id, subject, priority, ...(resolvedOwnerId ? { ownerId: resolvedOwnerId } : {}) },
            ...(ownerWarning ? { ownerWarning } : {}),
          };
        }

        ctx.audit.log({
          action: "crm.createTask",
          details: {
            subject: auditPreview(subject),
            dueDate: dueDate ?? "today",
            contactId,
            ...(resolvedOwnerId ? { ownerId: resolvedOwnerId } : {}),
            ...(ownerEmail ? { ownerEmail: auditPreview(ownerEmail) } : {}),
          },
          success: true,
        });

        const portalId = await getHubSpotPortalId(apiKey);

        return {
          success: true,
          task: {
            id: task.id,
            subject,
            priority,
            dueDate: timestamp.toISOString(),
            contactUrl: hubspotUrl(portalId, "contact", contactId),
            ...(resolvedOwnerId ? { ownerId: resolvedOwnerId } : {}),
          },
          message:
            "Richiesta di richiamata creata con successo e associata al contatto.",
          ...(ownerWarning ? { ownerWarning } : {}),
        };
      } catch (err) {
        ctx.audit.log({
          action: "crm.createTask",
          details: { contactId },
          success: false,
          error: errMsg(err),
        });
        return {
          error: `Errore creazione task di richiamata: ${errMsg(err)}`,
        };
      }
    },
});
