export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://freetruckingleads.goshbuzz.com').replace(/\/+$/, '');
export const SITE_NAME = 'Free Trucking Leads by GoshBuzz';
export const SITE_DESCRIPTION = 'Find US trucking leads using public FMCSA carrier and insurance data. Search new authority and renewal opportunities, filter results, and export a CSV.';

export const FAQS = [
  { q: 'What are trucking leads?', a: 'Trucking leads are records of motor carriers that businesses can use to identify potential customers. This tool searches public FMCSA carrier and insurance data, with filters to help narrow the results.' },
  { q: 'What is the difference between new authority and renewal leads?', a: 'New authority prospects are carriers entering the market; renewal prospects are carriers whose insurance dates may indicate an upcoming renewal. Check each record before contacting a carrier: an insurance effective date is not necessarily the date an operating authority was granted.' },
  { q: 'Where does the data come from?', a: 'The tool uses public FMCSA data, including the Company Census File and insurance filings available through the US Department of Transportation. Carrier details can also be enriched using FMCSA QCMobile. Records may be incomplete or delayed at the source.' },
  { q: 'Can I filter and export carrier leads?', a: 'Yes. The lead tool offers date, state, operation, cargo and other filters, and lets you export results to CSV. Available fields depend on the source records.' },
  { q: 'Are email addresses and phone numbers guaranteed?', a: 'No. Contact and insurance details are included when available from the data sources. Information can be missing or out of date, so verify it before use.' },
  { q: 'Who can use this tool?', a: 'Insurance agents, factoring providers, dispatch services, ELD vendors, freight brokers and other businesses researching US motor carriers can use the search. Follow applicable privacy, telemarketing and email rules when contacting businesses.' },
  { q: 'How will unique leads be counted?', a: 'The planned monthly allowances count each carrier once per account in a month. A carrier may count again in a new month. These limits are not yet enforced.' },
  { q: 'When will the paid plans be available?', a: 'The planned options are 200 free leads per month, $5 per month for 5,000 leads and $10 per month for unlimited leads. Checkout, accounts and plan limits are not live yet; no payment is being collected through this site.' },
];

export function organizationJsonLd() {
  return { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${SITE_URL}/#organization`, name: SITE_NAME, url: SITE_URL, logo: `${SITE_URL}/logo-512.png`, parentOrganization: { '@type': 'Organization', name: 'GoshBuzz', url: 'https://goshbuzz.com' } };
}
export function websiteJsonLd() {
  return { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${SITE_URL}/#website`, name: SITE_NAME, url: SITE_URL, description: SITE_DESCRIPTION, publisher: { '@id': `${SITE_URL}/#organization` }, inLanguage: 'en-US' };
}
export function faqJsonLd() {
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQS.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) };
}
