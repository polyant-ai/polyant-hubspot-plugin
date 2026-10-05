// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import type { ToolContext } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../lib/error.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES } from "../lib/hubspot-fetch.js";

const ACCESS_VALUES = ["PUBLIC_INDEXABLE", "PUBLIC_NOT_INDEXABLE", "PRIVATE"] as const;
type Access = (typeof ACCESS_VALUES)[number];

const FILES_API = "https://api.hubapi.com/files/v3/files";
const NOTES_API = "https://api.hubapi.com/crm/v3/objects/notes";

export default defineTool({
  name: "file",
  description:
    "Tool multi-action per HubSpot Files. Discriminatore: `action`.\n\n" +
    "action='upload' (default se action è null/omesso):\n" +
    "  Carica un file su HubSpot Files (Files API v3). Consuma un fileHandle prodotto da un tool che genera file (es. extra__markdownToPdf) (one-shot, valido 10 minuti).\n" +
    "  Con access=PUBLIC_NOT_INDEXABLE il file ha un URL pubblico utilizzabile come allegato (es. mediaUrl WhatsApp).\n" +
    "  Se passi associateContactId, il file viene ASSOCIATO al contatto (visibile nella scheda Attachments del contact in HubSpot UI), SENZA creare nessuna nota.\n" +
    "  Se passi associateContactId E noteBody, oltre all'association viene anche creata una Note engagement con il body HTML fornito. Il body supporta i placeholder {{FILE_URL}} e {{FILENAME}} che vengono sostituiti dal tool con l'URL pubblico e il filename effettivi.\n\n" +
    "action='search':\n" +
    "  Recupera l'UNICO PDF associato a un contatto. Richiede associateContactId. Tutti gli altri parametri sono ignorati.\n" +
    "  Cerca in entrambe le forme HubSpot: (a) file→contact associations dirette, (b) note engagement con hs_attachment_ids (caso 'Add attachment' da UI HubSpot). Unione + dedupe, poi filtra per estensione 'pdf' — altri file (immagini profilo, screenshot, doc misti) vengono ignorati.\n" +
    "  Esiti: { success: true, fileId, filename, publicUrl, createdAt } se trovato esattamente 1 PDF.\n" +
    "  Esito errore con errorCode='NOT_FOUND' se 0 PDF. Esito errore con errorCode='MULTIPLE_FOUND' (+ campo count) se >1 PDF: il caso d'uso prevede 1:1 contatto↔PDF.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Upload PDF e associa file→contatto (no nota)",
      input: {
        action: "upload",
        fileHandle: "artifact_<uuid>",
        filename: "preventivo-2026-001.pdf",
        access: "PUBLIC_NOT_INDEXABLE",
        associateContactId: "12345",
      },
    },
    {
      label: "Upload con nota custom + placeholder",
      input: {
        action: "upload",
        fileHandle: "artifact_<uuid>",
        filename: "contratto.pdf",
        associateContactId: "12345",
        noteBody: "<p>Contratto inviato il 2026-05-11: <a href=\"{{FILE_URL}}\">{{FILENAME}}</a></p>",
      },
    },
    {
      label: "Search: recupera il singolo file associato al contatto",
      input: {
        action: "search",
        associateContactId: "780919107780",
      },
    },
  ],
  parameters: z.object({
      action: z
        .enum(["upload", "search"])
        .nullable()
        .describe("Discriminatore. 'upload' (default se null) carica un file via fileHandle. 'search' recupera l'unico file associato a un contatto (richiede associateContactId)."),
      fileHandle: z
        .string()
        .nullable()
        .describe("OBBLIGATORIO per action='upload'. Handle opaco restituito da un tool che genera file (es. extra__markdownToPdf) (consumato una sola volta). Ignorato per action='search'."),
      filename: z
        .string()
        .nullable()
        .describe("OBBLIGATORIO per action='upload'. Nome file su HubSpot (es. 'preventivo.pdf'). Estensione .pdf consigliata. Ignorato per action='search'."),
      access: z
        .enum(ACCESS_VALUES)
        .nullable()
        .describe("Solo per action='upload'. Visibilità del file. Default PUBLIC_NOT_INDEXABLE. Ignorato per action='search'."),
      folderPath: z
        .string()
        .nullable()
        .describe("Solo per action='upload'. Cartella HubSpot di destinazione. Default '/polyant'. Ignorato per action='search'."),
      associateContactId: z
        .string()
        .nullable()
        .describe("Per action='upload': opzionale, associa il file al contatto. Per action='search': OBBLIGATORIO, identifica il contatto di cui recuperare il file."),
      noteBody: z
        .string()
        .nullable()
        .describe("Solo per action='upload'. Body HTML della Note engagement opzionale (richiede associateContactId). Supporta placeholder {{FILE_URL}} e {{FILENAME}}. Ignorato per action='search'."),
    }),
  execute: async (params: {
      action: "upload" | "search" | null;
      fileHandle: string | null;
      filename: string | null;
      access: Access | null;
      folderPath: string | null;
      associateContactId: string | null;
      noteBody: string | null;
    }, ctx) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      const action: "upload" | "search" = params.action ?? "upload";

      if (action === "search") {
        return await searchFileForContact(ctx, apiKey, params.associateContactId);
      }

      // action === "upload" — validate required params for this branch
      if (!params.fileHandle) {
        return { error: "fileHandle obbligatorio per action='upload'." };
      }
      if (!params.filename) {
        return { error: "filename obbligatorio per action='upload'." };
      }
      // Narrowed locals so TypeScript propagates non-null through callbacks/closures below.
      const fileHandle: string = params.fileHandle;
      const filename: string = params.filename;

      // The bytes come from another plugin's tool through the engine's
      // artifact store, bound to this conversation. One take consumes it.
      let entry: Awaited<ReturnType<typeof ctx.artifacts.take>>;
      try {
        entry = await ctx.artifacts.take(fileHandle);
      } catch (err) {
        // Only a dev-mode bridge can fail here (the in-process store never
        // throws): answer the model, do not abort the turn.
        return { error: `fileHandle "${fileHandle}" non leggibile: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!entry) {
        return {
          error: `fileHandle "${fileHandle}" non trovato o scaduto. Rigenera il file (es. con extra__markdownToPdf) e riprova.`,
        };
      }

      const access: Access = params.access ?? "PUBLIC_NOT_INDEXABLE";
      const folderPath = params.folderPath ?? "/polyant";

      let fileId: string;
      let publicUrl: string;
      try {
        const uploaded = await uploadFile(apiKey, entry.buffer, filename, entry.mime, access, folderPath);
        fileId = uploaded.id;
        publicUrl = uploaded.url;
      } catch (err) {
        ctx.audit.log({
          action: "hubspot.fileUpload",
          details: { filename, sizeBytes: entry.buffer.length, access, folderPath },
          success: false,
          error: errMsg(err),
        });
        return { error: `Errore upload HubSpot Files: ${errMsg(err)}` };
      }

      ctx.audit.log({
        action: "hubspot.fileUpload",
        details: {
          filename,
          sizeBytes: entry.buffer.length,
          access,
          folderPath,
          fileId,
        },
        success: true,
      });

      const warnings: string[] = [];
      let associatedContactId: string | undefined;
      let engagementId: string | undefined;

      if (params.associateContactId) {
        // 1) Always: associate file -> contact (visible in contact's Attachments).
        try {
          await associateFileToContact(apiKey, fileId, params.associateContactId);
          associatedContactId = params.associateContactId;
          ctx.audit.log({
            action: "hubspot.fileAssociate",
            details: { fileId, contactId: params.associateContactId },
            success: true,
          });
        } catch (err) {
          warnings.push(`Association file→contact non creata: ${errMsg(err)}`);
          ctx.audit.log({
            action: "hubspot.fileAssociate",
            details: { fileId, contactId: params.associateContactId },
            success: false,
            error: errMsg(err),
          });
        }

        // 2) Optional: create an engagement note if a custom body was provided.
        if (params.noteBody) {
          try {
            const body = substituteTemplatePlaceholders(params.noteBody, { fileUrl: publicUrl, filename });
            engagementId = await createNoteForContact(apiKey, body, params.associateContactId);
            ctx.audit.log({
              action: "hubspot.fileNote",
              details: { fileId, contactId: params.associateContactId, engagementId },
              success: true,
            });
          } catch (err) {
            warnings.push(`Nota non creata: ${errMsg(err)}`);
            ctx.audit.log({
              action: "hubspot.fileNote",
              details: { fileId, contactId: params.associateContactId },
              success: false,
              error: errMsg(err),
            });
          }
        }
      }

      return {
        success: true,
        fileId,
        publicUrl,
        ...(associatedContactId ? { associatedContactId } : {}),
        ...(engagementId ? { engagementId } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
});

function substituteTemplatePlaceholders(
  body: string,
  vars: { fileUrl: string; filename: string },
): string {
  return body
    .replaceAll("{{FILE_URL}}", vars.fileUrl)
    .replaceAll("{{FILENAME}}", vars.filename);
}

async function uploadFile(
  apiKey: string,
  buffer: Buffer,
  filename: string,
  mime: string,
  access: Access,
  folderPath: string,
): Promise<{ id: string; url: string }> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mime });
  form.append("file", blob, filename);
  form.append("folderPath", folderPath);
  form.append(
    "options",
    JSON.stringify({
      access,
      overwrite: false,
      duplicateValidationStrategy: "NONE",
      duplicateValidationScope: "EXACT_FOLDER",
    }),
  );

  const res = await hubspotFetch(FILES_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(`HubSpot Files API ${res.status}: ${respBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as { id?: string; url?: string };
  if (!data.id || !data.url) {
    throw new Error(`HubSpot Files API response missing id/url: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { id: data.id, url: data.url };
}

/**
 * Associate a HubSpot file with a contact via the Associations v4 default API.
 *
 * Endpoint: PUT /crm/v4/objects/contacts/{contactId}/associations/default/files/{fileId}
 * HubSpot picks the standard association type ("contact_to_file") automatically.
 * Result in HubSpot UI: the file appears under the contact's Attachments tab,
 * with no engagement note required.
 */
async function associateFileToContact(
  apiKey: string,
  fileId: string,
  contactId: string,
): Promise<void> {
  const url = `https://api.hubapi.com/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/files/${encodeURIComponent(fileId)}`;
  const res = await hubspotFetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(`File→Contact association ${res.status}: ${respBody.slice(0, 200)}`);
  }
}

async function createNoteForContact(
  apiKey: string,
  bodyHtml: string,
  contactId: string,
): Promise<string> {
  const createRes = await hubspotFetch(NOTES_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      properties: {
        hs_note_body: bodyHtml,
        hs_timestamp: new Date().toISOString(),
      },
    }),
  });

  if (!createRes.ok) {
    const respBody = await createRes.text();
    throw new Error(`Create note ${createRes.status}: ${respBody.slice(0, 200)}`);
  }

  const note = (await createRes.json()) as { id: string };

  const assocRes = await hubspotFetch(
    "https://api.hubapi.com/crm/v3/associations/notes/contacts/batch/create",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        inputs: [{ from: { id: note.id }, to: { id: contactId }, type: HUBSPOT_ASSOCIATION_TYPES.noteToContact }],
      }),
    },
  );

  if (!assocRes.ok) {
    const respBody = await assocRes.text();
    throw new Error(`Associate note→contact ${assocRes.status}: ${respBody.slice(0, 200)}`);
  }

  return note.id;
}

/**
 * Look up the single PDF file associated to a contact.
 *
 * HubSpot exposes "files attached to a contact" through TWO different shapes
 * depending on how the file was uploaded:
 *
 *   Source A — direct file→contact associations (Associations API v4).
 *     Created when the file is associated programmatically (e.g. via this
 *     tool's `action="upload"` branch with associateContactId).
 *     Endpoint: GET /crm/v4/objects/contacts/{contactId}/associations/files
 *
 *   Source B — note engagement with hs_attachment_ids.
 *     Created when the file is uploaded via the HubSpot UI on the contact
 *     record ("Add attachment"). HubSpot creates an empty engagement note
 *     (hs_note_body=null) whose hs_attachment_ids property is a CSV of file
 *     IDs, and associates that note to the contact.
 *     Endpoint: GET /crm/v4/objects/contacts/{contactId}/associations/notes
 *               then POST /crm/v3/objects/notes/batch/read?properties=
 *               hs_attachment_ids
 *
 * Both sources are queried, the union is deduplicated, file metadata is
 * fetched for each unique fileId, and the result is filtered to PDFs only
 * (extension === "pdf"). Non-PDF artefacts a contact may carry — profile
 * pictures, screenshots, generic .docx — are ignored so the 1:1 contract
 * applies only to the relevant artefact.
 *
 * Contract: a contact must have **exactly 1** PDF attached (via either shape).
 *   0 PDFs → returns { error, errorCode: "NOT_FOUND" }
 *   >1 PDFs → returns { error, errorCode: "MULTIPLE_FOUND", count }
 *   1 PDF → returns { success: true, fileId, filename, publicUrl, createdAt }
 *
 * All audit logging happens inside this helper (`hubspot.fileSearch`).
 * Generic HTTP/network errors are returned as `{ error }` without an `errorCode`
 * so the caller (the LLM via prompt) can distinguish "file missing" from
 * "HubSpot unreachable".
 */
async function searchFileForContact(
  ctx: ToolContext,
  apiKey: string,
  contactId: string | null,
): Promise<
  | { success: true; fileId: string; filename: string | null; publicUrl: string | null; createdAt: string | null; contactId: string }
  | { error: string; errorCode?: "NOT_FOUND" | "MULTIPLE_FOUND"; contactId?: string; count?: number }
> {
  if (!contactId) {
    return { error: "associateContactId obbligatorio per action='search'." };
  }

  // ---------- Source A: direct file associations ----------
  const fileIdsFromAssoc: string[] = [];
  {
    const url = `https://api.hubapi.com/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/files`;
    let res: Response;
    try {
      res = await hubspotFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, phase: "file-associations" },
        success: false,
        error: errMsg(err),
      });
      return { error: `Errore HubSpot associations: ${errMsg(err)}` };
    }
    if (!res.ok) {
      const body = await res.text();
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, phase: "file-associations", httpStatus: res.status },
        success: false,
        error: body.slice(0, 200),
      });
      return { error: `HubSpot associations API ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { results?: Array<{ toObjectId: string | number }> };
    for (const r of data.results ?? []) {
      fileIdsFromAssoc.push(String(r.toObjectId));
    }
  }

  // ---------- Source B: note engagements with hs_attachment_ids ----------
  const fileIdsFromNotes: string[] = [];
  {
    // B.1 list note associations
    const url = `https://api.hubapi.com/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/notes`;
    let res: Response;
    try {
      res = await hubspotFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, phase: "note-associations" },
        success: false,
        error: errMsg(err),
      });
      return { error: `Errore HubSpot note associations: ${errMsg(err)}` };
    }
    if (!res.ok) {
      const body = await res.text();
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, phase: "note-associations", httpStatus: res.status },
        success: false,
        error: body.slice(0, 200),
      });
      return { error: `HubSpot note associations API ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { results?: Array<{ toObjectId: string | number }> };
    const noteIds = (data.results ?? []).map((r) => String(r.toObjectId));

    // B.2 batch-read note properties (only if there are notes)
    if (noteIds.length > 0) {
      let batchRes: Response;
      try {
        batchRes = await hubspotFetch("https://api.hubapi.com/crm/v3/objects/notes/batch/read", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: noteIds.map((id) => ({ id })),
            properties: ["hs_attachment_ids"],
          }),
        });
      } catch (err) {
        ctx.audit.log({
          action: "hubspot.fileSearch",
          details: { contactId, phase: "notes-batch-read" },
          success: false,
          error: errMsg(err),
        });
        return { error: `Errore HubSpot notes batch read: ${errMsg(err)}` };
      }
      if (!batchRes.ok) {
        const body = await batchRes.text();
        ctx.audit.log({
          action: "hubspot.fileSearch",
          details: { contactId, phase: "notes-batch-read", httpStatus: batchRes.status },
          success: false,
          error: body.slice(0, 200),
        });
        return { error: `HubSpot notes batch read ${batchRes.status}: ${body.slice(0, 200)}` };
      }
      const batchData = (await batchRes.json()) as {
        results?: Array<{ id: string; properties: Record<string, string | null> }>;
      };
      for (const note of batchData.results ?? []) {
        const csv = note.properties?.hs_attachment_ids;
        if (!csv) continue;
        for (const piece of csv.split(",")) {
          const id = piece.trim();
          if (id) fileIdsFromNotes.push(id);
        }
      }
    }
  }

  // ---------- Union + dedupe ----------
  const uniqueFileIds = Array.from(new Set([...fileIdsFromAssoc, ...fileIdsFromNotes]));

  if (uniqueFileIds.length === 0) {
    ctx.audit.log({
      action: "hubspot.fileSearch",
      details: { contactId, count: 0, viaAssociation: 0, viaNote: 0 },
      success: false,
      error: "NOT_FOUND",
    });
    return {
      error: "Nessun file associato al contatto.",
      errorCode: "NOT_FOUND",
      contactId,
    };
  }

  // ---------- Fetch metadata + filter to PDFs ----------
  type FileMeta = { id: string; name?: string; url?: string; createdAt?: string; extension?: string };
  const pdfs: FileMeta[] = [];
  for (const fileId of uniqueFileIds) {
    const metaUrl = `https://api.hubapi.com/files/v3/files/${encodeURIComponent(fileId)}`;
    let res: Response;
    try {
      res = await hubspotFetch(metaUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, fileId, phase: "file-metadata" },
        success: false,
        error: errMsg(err),
      });
      return { error: `Errore HubSpot file metadata (${fileId}): ${errMsg(err)}` };
    }
    if (!res.ok) {
      // Skip individual file fetch failures (file may have been deleted but the
      // hs_attachment_ids still references it). Log + continue rather than fail
      // the whole search.
      const body = await res.text();
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, fileId, phase: "file-metadata", httpStatus: res.status },
        success: false,
        error: body.slice(0, 200),
      });
      continue;
    }
    const meta = (await res.json()) as FileMeta;
    if ((meta.extension ?? "").toLowerCase() === "pdf") {
      pdfs.push(meta);
    }
  }

  if (pdfs.length === 0) {
    ctx.audit.log({
      action: "hubspot.fileSearch",
      details: {
        contactId,
        count: 0,
        viaAssociation: fileIdsFromAssoc.length,
        viaNote: fileIdsFromNotes.length,
        totalUnique: uniqueFileIds.length,
      },
      success: false,
      error: "NOT_FOUND",
    });
    return {
      error: "Nessun PDF associato al contatto.",
      errorCode: "NOT_FOUND",
      contactId,
    };
  }

  if (pdfs.length > 1) {
    ctx.audit.log({
      action: "hubspot.fileSearch",
      details: {
        contactId,
        count: pdfs.length,
        viaAssociation: fileIdsFromAssoc.length,
        viaNote: fileIdsFromNotes.length,
      },
      success: false,
      error: "MULTIPLE_FOUND",
    });
    return {
      error: `Trovati ${pdfs.length} PDF associati al contatto (atteso 1).`,
      errorCode: "MULTIPLE_FOUND",
      contactId,
      count: pdfs.length,
    };
  }

  const meta = pdfs[0];
  const fileId = meta.id;

  ctx.audit.log({
    action: "hubspot.fileSearch",
    details: {
      contactId,
      fileId,
      filename: meta.name,
      viaAssociation: fileIdsFromAssoc.includes(fileId),
      viaNote: fileIdsFromNotes.includes(fileId),
    },
    success: true,
  });

  return {
    success: true,
    fileId: meta.id,
    filename: meta.name ?? null,
    publicUrl: meta.url ?? null,
    createdAt: meta.createdAt ?? null,
    contactId,
  };
}

