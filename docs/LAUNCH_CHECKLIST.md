# Launch checklist

## Domain and indexing

1. Add `freetruckingleads.goshbuzz.com` to your hosting project and follow its DNS instructions. Set `NEXT_PUBLIC_SITE_URL=https://freetruckingleads.goshbuzz.com` in production if overriding the default.
2. Verify the site in Google Search Console (DNS verification is recommended; alternatively set `GOOGLE_SITE_VERIFICATION` to the verification token). Submit `https://freetruckingleads.goshbuzz.com/sitemap.xml` after deployment.
3. Publicly crawlable favicon and Organization structured-data logo are included. Google decides whether and when to display them; indexing, rich results and rankings are not guaranteed. FAQ rich results have restricted eligibility.
4. Set `FMCSA_WEB_KEY` and optionally `SOCRATA_APP_TOKEN`, and do not enable `MOCK_FMCSA` in production. Verify source freshness, missing fields and operational limits in production.

## Payments and lead access — NOT LIVE

The pricing on the homepage is a proposal. There is no Stripe checkout or entitlement enforcement and no charges are taken. The existing lead tool is unrestricted by plan and can return up to its per-request deployment cap; it does not enforce the proposed 200-lead monthly allowance. Do not advertise the tiers as active or accept payments until the following are complete:

- The requested tiers are 200 free leads per month, $5/month for 5,000 leads, and $10/month for unlimited leads. A repeated carrier does not count again within the same month; it can count again in a new month. The $10 subscription renews monthly until canceled. Confirm exact reset dates, rollover, and behavior when changing plans.
- `lib/lead-quota.ts` contains tested allocation policy only. It is not wired to any endpoint and does not persist usage or enforce limits.
- Create customer accounts with secure authentication and persistent storage. Track unique carrier usage and active subscriptions server-side. Enforce limits on every lead and enrichment endpoint, including concurrent requests, previews, exports, and retries. Restrict free-tier usage across accounts sharing an IP using a trusted proxy address; IP limits cannot completely prevent abuse and may block legitimate shared networks. Define a privacy and dispute policy and additional anti-abuse measures.
- Create Stripe products/prices and a server-side checkout using allowlisted price IDs. Grant access only after a verified Stripe webhook, with idempotent event processing; handle payment failure, subscription cancellation, refunds and disputes. Include a customer billing portal and secure account recovery.
- Test the full purchase-to-access lifecycle with Stripe test mode and production-like persistence before enabling live payments. Publish terms, privacy, refund and cancellation policies.

A browser flag or success-page redirect alone is not secure payment verification and must not grant access.
