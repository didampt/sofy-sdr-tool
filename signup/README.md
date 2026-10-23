# Sofy signup

## Company registry (Vercel server-side environment)

- `SOFY_ENTREPRISES_API_URL` (optional): defaults to `https://entreprises.system.sofy.fr`. Override with another publicly reachable HTTP(S) base URL, without `/api/companies`. Use HTTPS for the hosted service.
- `SOFY_ENTREPRISES_API_KEY`: matches the Entreprises service's `API_KEY`.

Set the API key on the Vercel **signup project** and redeploy it. The URL override is optional. A Kubernetes ClusterIP address cannot be reached directly by Vercel; use the service's public ingress URL. The URL must be final: redirects are rejected to avoid forwarding credentials unexpectedly.

The frontend keeps calling `/api/pappers-search?q=…&cursor=…` and `/api/pappers-company?siret=…`. Those serverless handlers proxy to `/api/companies` and `/api/companies/{siret}`, using a bearer token and an eight-second upstream timeout. Search pagination, SIREN/SIRET lookup, rate limits, and successful-response caches are retained. A stale pagination cursor (HTTP 409 after a registry refresh) restarts the dropdown from a fresh first page. The key is never sent to the browser. `PAPPERS_API_TOKEN` is no longer used by these signup handlers.

The main SDR prospecting/enrichment handlers still use Pappers for their richer filters and data.

Run the company lookup checks with:

```sh
node --test signup/tests/entreprises.test.js
```

The integration check `signup/tests/entreprises.integration.test.js` uses a real local registry container rather than a fetch mock. From the Entreprises repository, run:

```sh
python3 scripts/smoke-test.py --signup-dir /path/to/sofy-sdr-tool
```

The harness supplies a loopback registry URL and a temporary key, exercises both signup HTTP handlers, and cleans up the fixture container/volume. The integration test skips unless `REGISTRY_TEST_URL` and `REGISTRY_TEST_KEY` are supplied; it refuses a non-loopback host. Company names, identifiers, cities, and lookup errors are escaped before insertion into the dropdown HTML.
