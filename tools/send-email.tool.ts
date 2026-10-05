// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../lib/error.js";
import { auditPreview } from "../lib/audit-preview.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES } from "../lib/hubspot-fetch.js";
import { getHubSpotPortalId, hubspotUrl } from "../lib/hubspot-portal.js";

export default defineTool({
  name: "sendEmail",
  description:
    "Invia un'email tracciata via HubSpot e la associa a un contatto nel CRM.\n" +
    "Usa per email di follow-up, outreach, comunicazioni commerciali o notifiche. L'email viene registrata nella timeline del contatto.\n" +
    "NON usare per creare note — usa hubspot__note.\n" +
    "NON usare per comunicazioni via canali (Telegram, Slack) — usa i canali configurati.\n" +
    "Restituisce ID dell'email inviata e URL nel portale HubSpot.\n" +
    "Caveat: richiede contactId (il contatto deve avere un'email). Il body supporta HTML.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Email di follow-up",
      input: { contactId: "12345", subject: "Seguito alla nostra conversazione", body: "Gentile Mario, come concordato le invio il riepilogo..." },
    },
  ],
  parameters: z.object({
      contactId: z
        .string()
        .describe("ID del contatto HubSpot destinatario (l'email viene associata automaticamente al contatto)"),
      subject: z
        .string()
        .describe("Oggetto dell'email"),
      body: z
        .string()
        .describe("Corpo dell'email (testo o HTML)"),
    }),
  execute: async (params: {
      contactId: string;
      subject: string;
      body: string;
    }, ctx) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      try {
        // 1. Create the email engagement
        // Note: hs_email_to_email, hs_email_from_email, hs_email_sender_email
        // are READ-ONLY properties in HubSpot API — they cannot be set via API.
        // The association (step 2) links the email to the contact instead.
        const emailProperties: Record<string, string> = {
          hs_email_subject: params.subject,
          hs_email_text: params.body,
          hs_email_html: params.body,
          hs_email_direction: "EMAIL",
          hs_email_status: "SENT",
          hs_timestamp: new Date().toISOString(),
        };

        const createResponse = await hubspotFetch(
          "https://api.hubapi.com/crm/v3/objects/emails",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ properties: emailProperties }),
          },
        );

        if (!createResponse.ok) {
          const respBody = await createResponse.text();
          return { error: `Errore creazione email (${createResponse.status}): ${respBody.slice(0, 200)}` };
        }

        const email = (await createResponse.json()) as {
          id: string;
          properties: Record<string, string | null>;
        };

        // 2. Associate email with contact (type 198 = email-to-contact)
        const assocResponse = await hubspotFetch(
          "https://api.hubapi.com/crm/v3/associations/emails/contacts/batch/create",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              inputs: [
                {
                  from: { id: email.id },
                  to: { id: params.contactId },
                  type: HUBSPOT_ASSOCIATION_TYPES.emailToContact,
                },
              ],
            }),
          },
        );

        if (!assocResponse.ok) {
          const respBody = await assocResponse.text();
          return {
            success: true,
            warning: `Email creata (ID: ${email.id}) ma associazione al contatto fallita: ${respBody.slice(0, 200)}`,
            email: { id: email.id, subject: params.subject },
          };
        }

        ctx.audit.log({
          action: "crm.sendEmail",
          details: {
            emailId: email.id,
            subject: auditPreview(params.subject),
            contactId: params.contactId,
          },
          success: true,
        });

        const portalId = await getHubSpotPortalId(apiKey);

        return {
          success: true,
          email: {
            id: email.id,
            subject: params.subject,
            contactUrl: hubspotUrl(portalId, "contact", params.contactId),
          },
          message: "Email inviata e registrata nella timeline del contatto.",
        };
      } catch (err) {
        ctx.audit.log({
          action: "crm.sendEmail",
          details: {
            subject: auditPreview(params.subject),
            contactId: params.contactId,
          },
          success: false,
          error: errMsg(err),
        });
        return { error: `Errore invio email: ${errMsg(err)}` };
      }
    },
});
