# polyant-hubspot-plugin

HubSpot CRM tools for [Polyant](https://github.com/polyant-ai/polyant), packaged as a
plugin so that a deployment that does not use HubSpot does not carry them. The plugin
is also installable from the Polyant marketplace for Polyant Enterprise.

## Tools

The plugin namespace is `hubspot`, so the engine registers each tool as
`hubspot:<name>`. The model sees the same name with `__` in place of the colon, for
example `hubspot__contact`.

| Tool | What it does |
| --- | --- |
| `hubspot:contact` | create, update, search contacts (including custom properties) |
| `hubspot:deal` | create, update, search deals |
| `hubspot:ticket` | create, update, get, search tickets |
| `hubspot:note` | create, update, search note engagements |
| `hubspot:meeting` | create, get, update meeting engagements |
| `hubspot:createTask` | create a task engagement |
| `hubspot:sendEmail` | send a one-to-one email through HubSpot |
| `hubspot:getCompany` | look a company up by name or domain |
| `hubspot:file` | upload a generated file to HubSpot Files, or find the PDF attached to a contact |

## Requirements

- Polyant engine 1.3.0 or later (`plugin.json` declares `"engine": ">=1.3.0"`).
- Plugin SDK `@polyant-ai/plugin-sdk` v1.10.0, installed as a git dependency from
  `github.com/polyant-ai/polyant-sdk` when the plugin is built.
- A HubSpot [private app](https://developers.hubspot.com/docs/api/private-apps) whose
  token carries the scopes for the objects the agent works with (contacts, companies,
  deals, tickets, notes, meetings, tasks, emails, files).

The plugin needs no system packages, so `plugin.json` declares no `system` block.

## Secret

Every tool declares one secret, `hubspot_api_key`: the private app token. Set it in the
agent's secrets in the admin panel, which shows its label and description in the reader's language. The engine hands a tool only the secrets it
declared, and the plugin sees nothing beyond what the token allows.

## Installing on an OSS engine image

The engine image bakes plugins in at build time. `Dockerfile.engine` copies every
directory under `packages/engine/src/plugins/` that contains a `plugin.json`, installs
its dependencies, and compiles its TypeScript. To add this plugin, clone it there
before building the image, from the root of the Polyant repository:

```bash
git clone --depth 1 --branch v1.1.1 \
  https://github.com/polyant-ai/polyant-hubspot-plugin.git \
  packages/engine/src/plugins/hubspot
docker build -f Dockerfile.engine -t polyant-engine .
```

The directory is ignored by git in the Polyant repository, so the clone does not
dirty its working tree. After the engine boots, enable the `hubspot:*` tools on the
agents that should use them. See the Polyant `docs/plugins.md` for the plugin contract.

## File handoff

`hubspot:file` with `action: "upload"` does not take bytes. It takes a `fileHandle`
minted by whichever tool produced the file, for example `extra:markdownToPdf`, through
`ctx.artifacts`, the engine's short-lived store. Each handle is bound to the
conversation that produced it and one `take` consumes it, so two plugins exchange a
file without importing each other and without the bytes passing through the model.

## Development

```bash
npm ci
npm test
npm run typecheck
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
