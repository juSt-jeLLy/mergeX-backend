# mergeX Backend

Backend API for World ID routes and GitHub App repository fetch.

## Setup

```bash
cd mergeX-backend
npm install
```

Create `.env`:

```env
RP_SIGNING_KEY=...
RP_ID=...
GITHUB_APP_ID=3024176
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_SLUG=pltestforplgenesis
GITHUB_APP_INSTALL_URL=https://github.com/apps/pltestforplgenesis/installations/new
```

Important:

- Use full PEM key content for `GITHUB_APP_PRIVATE_KEY`
- Do not use the `SHA256:...` fingerprint value

## Run

```bash
node src/server.js
```

Server URL:

- `http://127.0.0.1:3001`

## Main endpoint

Fetch repository snapshot:

```bash
curl "http://127.0.0.1:3001/api/github/repo-snapshot?repoUrl=juSt-jeLLy/Veritasx"
```

If app is not installed on the target repo, response includes an install URL for the frontend flow.
