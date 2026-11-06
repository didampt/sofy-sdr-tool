# First self-service purchase

## Behavior

The Payments backend marks checkouts created through the public `BuyPack` service as `purchase_origin=self_service`. This covers packs and destination-based SMS/RCS purchases. Internal sales checkouts are unmarked and excluded. Only newly created checkouts receive the marker; historical payments/checkouts are not automatically backfilled.

After its existing signed `payment_intent.succeeded` processing has verified the amount, recorded payment with Zoho and successfully applied the wallet credits, Payments posts a purchase notification. Replayed successful events may post it again. The notification uses Stripe's original event time and PaymentIntent ID, not a browser redirect or the time of a retry.

The backend intentionally adds no storage, schema migration, queue, worker or deduplication. The POST has a five-second timeout and refuses redirects. Delivery failures return HTTP 503 so Stripe retries using its existing redelivery policy; the already applied wallet credits remain protected by their existing idempotency. There is no new backend retry worker or historical backfill. An outage beyond Stripe's retry period still requires event replay.

## Configuration

No new environment variables are needed. The Payments backend posts to this fixed opaque URL:

```text
https://sofy-sdr-tool.vercel.app/api/purchase-c8d6614869335b19882d8f877d35657b
```

The URL path is randomly generated (128 bits) and replaces the shared-token header. The receiver has no additional authentication. The backend sends only in production, based on the existing `ENV=production` setting, so staging and development do not send into the production CRM.

The receiver uses SDR's existing `DATABASE_URL`/`POSTGRES_URL` and `HUBSPOT_API_KEY`. Deploy the SDR receiver before deploying the backend sender. Keep the opaque path consistent in both repositories if it is ever changed.

Create this **company** property in HubSpot before enabling delivery:

| Label | Internal name | HubSpot type / fieldType |
| --- | --- | --- |
| Date du premier achat self-service | `sofy_first_self_service_purchase_at` | `date` / `date` |

The property contains the UTC calendar date of the earliest recorded self-service payment. No extra attribution, lifecycle or amount properties are required. Amount and currency are retained in the server-side purchase fact, not written into CRM fields.

## Receiver contract

```http
POST /api/purchase-c8d6614869335b19882d8f877d35657b
Content-Type: application/json
```

```json
{
  "organization_id": "01K9CFY71N7N1M9D9E3D1B3D9E",
  "payment_id": "pi_example",
  "invoice_id": "invoice-example",
  "paid_at": "2026-11-06T12:34:56Z",
  "amount_cents": 2400,
  "currency": "eur"
}
```

The receiver derives company identity from the stored signup record for that organization. It first uses the signup contact's native association when exactly one company is linked. Otherwise it falls back to an exact SIRET match when available. The portal's existing SIRET field is numeric and may be empty because signup does not write identifiers into numeric properties; native contact/company association does not depend on it. It does not create CRM records or guess from a company name or email domain. Missing/ambiguous links return an error rather than updating the wrong company. If SIRET has a non-default internal property name, configure `HUBSPOT_SIGNUP_COMPANY_SIRET_PROPERTY` on SDR as well.

The existing `config` JSON store holds `self_service_purchase:<HubSpot company ID>`, updated atomically only for an earlier payment. A short per-company lease serializes CRM writes. Duplicate/later purchases do not overwrite an earlier CRM date. If an older payment arrives late, it can correct a later date. A failed CRM update keeps the purchase fact; a later notification can repair the CRM date. A busy lease returns 409 so the originating Stripe webhook can be retried; there is no autonomous receiver retry job.

HubSpot native traffic-source fields and lifecycle stages are unchanged. Report companies with a first-purchase date against native acquisition sources from their associated contacts. This date is not a HubSpot closed-won deal, so it does not by itself add revenue to native deal-revenue attribution reports. Exclude existing customers using lifecycle history relative to signup.

## Verified browser conversion / Google Ads

The app uses the Stripe-added `session_id` on the checkout success URL to request:

```http
GET /orgs/{orgID}/payments/checkout-conversion?session_id=cs_live_...
Authorization: Bearer <existing app token>
```

Payments retrieves the session from Stripe, checks that its organization matches the authenticated route, that it is paid and marked self-service, then asks the opaque receiver for the company first-purchase receipt (`operation: "lookup"`, organization ID and PaymentIntent ID). The opaque URL is never sent to the browser. No new backend table, migration, worker or environment variable is required.

The receiver returns 202 pending until a successful CRM sync has recorded eligibility. It returns confirmed/ineligible for subsequent payments and for companies with an earlier recorded CRM purchase date. Eligibility is stored on the existing company purchase fact and survives notification retries. Missing historical purchases are not backfilled; the CRM property has date precision, so existing same-day purchases cannot be distinguished without historical payment facts.

The webapp polls at most 15 times with two seconds between requests. This continues independently of the existing two-second payment loader and URL cleanup. Only a verified first purchase emits this payload on `app.sofy.fr`:

```js
window.dataLayer.push({
  event: 'purchase',
  transaction_id: 'pi_example',
  value: 24,
  currency: 'EUR'
});
```

The value is the confirmed amount paid (including any tax), in major currency units. No email, company name or other personal fields are included. PaymentIntent ID is stable across replays; the webapp also deduplicates in memory and session storage when available. Non-production backends return ineligible receipts.

AdPremier still needs to configure and publish the existing web GTM container:

1. Create a Custom Event trigger named `purchase`.
2. Create Data Layer Variables `transaction_id`, `value` and `currency`.
3. Attach a native Google Ads conversion tracking tag using the purchase conversion action's ID and label, mapping transaction ID, conversion value and currency to those variables. Configure the existing conversion linker and consent settings for the signup/app journey.
4. Validate in Tag Assistant and Google Ads with a real first self-service purchase. Avoid importing an additional GA4 conversion for the same purchase action, which would create a second measurement path.

This code makes an event available to GTM; it does not configure a Google Ads account or directly upload conversions. See [Google's data layer documentation](https://developers.google.com/tag-platform/tag-manager/datalayer).

Browser delivery requires the customer to return from Checkout and the tags to run. Closing the browser, blockers, consent restrictions or fulfillment taking longer than the bounded checks can prevent the Ads event. The server-side HubSpot date does not depend on browser return. There is no offline Ads import in this implementation.

Deploy the updated SDR receiver first, then Payments, then the webapp. Create the HubSpot company property before testing. No production rollout has been performed as part of local validation.

## Validation

- Backend: payment/transaction tests cover the verified timestamp/currency, public checkout marker, duplicate notifications, redirects, production-only delivery and notification errors occurring only after wallet crediting.
- Webapp: callback, bounded polling, first-purchase event, deduplication and production-host tests; TypeScript validation.
- SDR: `node --test tests/first-purchase.test.js` covers payload validation, company resolution, duplicate/later/older payments, failed CRM sync recovery and per-company lease isolation.
- Provider calls are mocked in these tests. Deployment, property creation and a consented signup-to-first-purchase end-to-end check remain to be performed.
