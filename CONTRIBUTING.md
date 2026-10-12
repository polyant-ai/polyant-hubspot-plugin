# Contributing

Thank you for your interest in this plugin. Bug reports and pull requests are welcome.

## Setup

You need Node.js 24 or later.

```bash
git clone https://github.com/polyant-ai/polyant-hubspot-plugin.git
cd polyant-hubspot-plugin
npm ci
```

## Checks

Run both before you push:

```bash
npm run typecheck
npm test
```

Tests mock the HubSpot API, so they need neither network access nor credentials. Use
fictitious names, phone numbers and e-mail addresses in tests and examples, never real
customer data.

## Making changes

1. Fork the repository and create a topic branch from `main`.
2. Keep each tool's input schema static and keep its behaviour independent of any
   particular customer or portal.
3. Tool descriptions, error messages and comments are in English.
4. Open a pull request against `main` with a clear title.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`), for example
`fix(contact): handle phone numbers without a country code`.

## Sign your work (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a Contributor License Agreement. Every commit must carry a `Signed-off-by`
line, which `git commit -s` adds from your `user.name` and `user.email`:

    git commit -s -m "fix: my change"

If you forgot to sign a commit, amend it with:

    git commit --amend -s --no-edit

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[AGPL-3.0-or-later](LICENSE).
