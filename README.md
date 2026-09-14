# polyant-hubspot-plugin

HubSpot CRM tools for Polyant, extracted from the engine core so a deployment that
does not use HubSpot does not carry them.

## Tools

The plugin namespace is `hubspot`, so the engine registers each tool as
`hubspot:<name>`.

| Tool | What it does |
| --- | --- |
| `hubspot:contact` | create, update, search contacts (including custom properties) |
| `hubspot:deal` | create, update, search deals |
| `hubspot:ticket` | create, update, search tickets |
| `hubspot:note` | create, update, search note engagements |
| `hubspot:meeting` | create and update meeting engagements |
| `hubspot:createTask` | create a task engagement |
| `hubspot:sendEmail` | send a one-to-one email through HubSpot |
| `hubspot:getCompany` | look a company up by name or domain |
| `hubspot:file` | upload a generated file to HubSpot Files, or find the PDF attached to a contact |

Every tool declares the `hubspot_api_key` secret and receives it through
`ctx.secrets`; the engine hands a tool only the keys it declared.

## Names changed on extraction

These tools were `hubspotContact`, `hubspotDeal` and so on while they lived in the
engine. The plugin namespace now carries the "hubspot" part, so the bare names
lost it. An agent that had the old tool enabled must have the new name enabled:
the catalogue entry is a different row.

`hubspot:file` also renamed its `pdfHandle` parameter to `fileHandle`, because the
bytes no longer have to come from a PDF renderer.

## The file handoff

`hubspot:file` with `action: "upload"` does not take bytes. It takes a handle
minted by whichever tool produced the file — `extra:markdownToPdf`, for instance —
through `ctx.artifacts`, the engine's short-lived store. The engine binds each
handle to the conversation that produced it and one `take` consumes it, so two
plugins exchange a file without importing each other and without the bytes ever
passing through the model.

## Development

```bash
npm install
npm test
npm run typecheck
```

Requires no system packages, so `plugin.json` declares no `system` block.
