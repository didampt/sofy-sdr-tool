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

## Signup acquisition tracking

The existing GTM container is `GTM-WLQCBNG3`. After `/api/signup` returns HTTP **201** for account creation or HTTP **202** for a successfully saved manual SMS review request, with `ok: true`, the browser pushes:

```js
{ event: 'sign_up', method: 'self_service', transaction_id: '<opaque server hash>' }
```

The hash derives from the signup reference; the OTP token, email, phone, name and company identifiers are not sent in this event. Session storage and an in-memory guard suppress repeat emissions of the same reference. Previews and unsuccessful requests emit no conversion. This event means the signup was accepted, **including requests awaiting manual SMS review and before commercial activation**. Saved manual-review requests also run the same best-effort HubSpot acquisition sync as created accounts. Later SDR activation must not emit a second signup conversion. Browser blocking/closing the page can prevent delivery; this is not a durable server-side conversion queue.

### GTM / AdPremier configuration required

1. Use a **Custom Event** trigger named exactly `sign_up`, restricted to `signup.sofy.fr`.
2. Attach a GA4 Event tag with event name `sign_up` and `method` from a Data Layer Variable. Mark `sign_up` as a GA4 key event.
3. Attach a Google Ads Conversion Tracking tag for the signup action, using the conversion ID and label from AdPremier. Set its Transaction ID from the Data Layer Variable `transaction_id`; use the **One** counting option for this lead action.
4. Configure the Google tag / Conversion Linker on the marketing site, signup and app, with compatible domain cookie settings. Enable Google Ads auto-tagging. Keep consent handling in the existing GTM setup.
5. Avoid counting the same signup twice in Ads: if the direct Ads conversion is the primary action, do not also count a GA4 import as a second primary action for that signup.
6. Validate a signup in Tag Assistant, GA4 DebugView and the Ads conversion diagnostics. Publishing app code does not publish GTM changes. No live container or Ads configuration was changed here.

The CSP permits Google's documented Ads endpoints, including `www.google.fr` for France; additional country-specific Google endpoints must be added explicitly if Tag Assistant reports them blocked. See [Google's data layer guide](https://developers.google.com/tag-platform/tag-manager/datalayer), [recommended events](https://developers.google.com/analytics/devguides/collection/ga4/reference/recommended-events), and [CSP requirements](https://developers.google.com/tag-platform/security/guides/csp).

### HubSpot native attribution — no custom acquisition properties

Signup loads the same EU HubSpot portal (`147834354`) as `www.sofy.fr`. The public portal ID was also verified with the signup project's CRM API key via the read-only account-details endpoint. The API key stays server-side.

The existing server integration still upserts the contact/company and associates them, including saved manual SMS review requests. After an accepted signup, the browser uses HubSpot's documented Tracking Code API:

```js
_hsq.push(['identify', { email: '<accepted signup email>' }]);
_hsq.push(['setPath', '/signup/confirmed']);
_hsq.push(['trackPageView']);
```

This links the browser's visitor cookie and earlier activity to the contact. HubSpot calculates **Original Traffic Source**, **Latest Traffic Source**, their drill-downs, and first/referring-page information using its own tracking. The CRM API does not set or overwrite those fields. The custom acquisition fields proposed previously and the legacy optional source/detail mappings are no longer used. Raw UTMs/referrer/click identifiers remain available in the existing CRM signup note and SDR payload for troubleshooting; they do not override native attribution.

Identification is sent only after acceptance (HTTP 201 or saved manual review HTTP 202) and after the tracker has reported analytics consent. A pending confirmation waits in memory if consent has not yet been granted. Denying analytics prevents identity/confirmation delivery; consenting later on the same page delivers it once. Blocked scripts, storage restrictions and tracking failures do not block signup. No identity is sent for form entry, OTP requests, errors, or UI previews. Localhost and Vercel preview hosts do not load the live HubSpot tracker.

HubSpot receives the email directly through its tracker; Google receives only the existing `sign_up` event with method and opaque transaction ID. Separate duplicate guards prevent Google tracking failure from suppressing HubSpot attribution or vice versa. The loader's optional advertising, collected-forms and interactive modules are not enabled in the signup CSP; native analytics and the consent banner are allowed. In particular, this does not auto-capture the signup/password form or count submit clicks before validation.

### HubSpot reporting and account settings

- In **Settings → Tracking & Analytics → Tracking Code → Advanced Tracking**, verify that `sofy.fr` covers the marketing and signup subdomains, or include `signup.sofy.fr` explicitly. Verify that cookies are shared at the root domain rather than isolated per subdomain. The live tracker currently limits tracking to configured domains; those account settings were not changed here.
- Apply the existing HubSpot consent-banner policy to signup. The integration respects the portal's analytics consent result and does not grant consent itself.
- Report accepted signups using native contact page-view activity for **`https://signup.sofy.fr/signup/confirmed`** and group by Original Traffic Source and its drill-downs. The path is a virtual page view, not a navigable route or a HubSpot form submission; native form-conversion fields such as Recent Conversion are not populated by this integration. Count contacts/companies distinctly according to the report, rather than summing every page view.
- For an existing contact, Original Traffic Source remains their earliest known source. Latest Traffic Source reflects subsequent sessions; it is not an immutable signup-source snapshot. Native attribution also does not freeze an "already Customer at signup" flag: use company lifecycle history/date of entry into Customer relative to the signup activity. Filtering only the current Customer stage would also exclude customers acquired after signup.
- Check one consented end-to-end visit from the marketing site to signup after deployment, then inspect the contact's page-view timeline and native source/drill-down fields. API creation can initially show Integration/Offline until HubSpot associates the tracked visit; Record Source can remain Integration because that describes record creation.

A page view cannot recover a marketing visit that was never tracked or whose cookies were denied/deleted. Use the same tracker on the first marketing landing page and preserve UTMs/Ads parameters across redirects. Campaign/search-term detail is limited to what HubSpot receives; organic search terms are often unavailable. The local-storage snapshot is retained only for the existing note, not used to reconstruct or fabricate native traffic history.

References: [HubSpot visitor identification](https://developers.hubspot.com/docs/api-reference/latest/account/settings/tracking-code/identify), [tracking-code overview](https://developers.hubspot.com/docs/api-reference/latest/account/settings/tracking-code/overview), [source updates](https://knowledge.hubspot.com/records/update-and-filter-contacts-using-traffic-source-properties), and [domain/cookie configuration](https://knowledge.hubspot.com/reports/set-up-sources-tracking).

### First purchase

The Payments backend now has a minimal notification (using Stripe webhook retries) after a confirmed self-service card payment. The SDR receiver (`api/purchase-c8d6614869335b19882d8f877d35657b.js`) records the earliest purchase on the existing HubSpot company in `sofy_first_self_service_purchase_at`, leaving native attribution unchanged. Duplicate notifications are accepted; later purchases preserve the earlier date.

See [payment tracking](../docs/payment-tracking.md) for the HubSpot company property, fixed receiver URL, delivery limits and Google Ads work still required. No payment-backend storage, migration, queue or worker is added.

### Local checks

```sh
node --test signup/tests/tracking.test.js signup/tests/hubspot-tracking.test.js signup/tests/otp-status.test.js
```

Checks use mocked providers and local execution; they do not establish live HubSpot acceptance or Google Ads attribution.
