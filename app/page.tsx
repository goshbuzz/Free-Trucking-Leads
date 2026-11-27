import Image from 'next/image';
import { FAQS, faqJsonLd } from '@/lib/site';

const plans = [
  { name: 'Free', price: '$0', suffix: '', amount: '200 leads / month', detail: 'New authority or renewal leads', features: ['Search public carrier data', 'Filter by state and date', 'Export results to CSV'], cta: 'Open the lead tool', href: '/tool' },
  { name: 'Monthly', price: '$5', suffix: '/ month', amount: '5,000 leads / month', detail: 'A low-cost option for focused outreach', features: ['New authority and renewal opportunities', 'Search and filter carrier records', 'Export results to CSV'], featured: true },
  { name: 'Unlimited', price: '$10', suffix: '/ month', amount: 'Unlimited leads', detail: 'For teams building a consistent pipeline', features: ['Search new and renewal opportunities', 'Filter across US states', 'Export results to CSV'], },
];

export default function HomePage() {
  return <div className="landing">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd()).replace(/</g, '\\u003c') }} />
    <header className="landing-header"><div className="landing-wrap nav-inner">
      <a href="/" className="landing-brand" aria-label="Free Trucking Leads by GoshBuzz home"><Image src="/logo-192.png" width={52} height={52} alt="" /><span><strong>FREE TRUCKING LEADS</strong><small>by GoshBuzz</small></span></a>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></nav>
      <a href="/tool" className="landing-button landing-button--small">Explore leads <span aria-hidden="true">↗</span></a>
    </div></header>
    <main>
      <section className="hero"><div className="landing-wrap hero-grid"><div className="hero-content">
        <div className="hero-kicker"><span /> YOUR NEXT CUSTOMER IS OUT THERE</div>
        <h1>Find the carriers.<br /><em>Grow your business.</em></h1>
        <p>Discover free trucking leads from public FMCSA data. Find new authority and insurance renewal opportunities without the complicated sales pitch.</p>
        <div className="hero-actions"><a href="/tool" className="landing-button">Explore trucking leads <span aria-hidden="true">→</span></a><a href="#how-it-works" className="hero-link">See how it works <span aria-hidden="true">↓</span></a></div>
        <div className="hero-note"><span>✦</span> Built for the businesses that keep trucking moving.</div>
      </div><div className="hero-photo" role="img" aria-label="A semi-truck on an American highway"><div className="photo-caption"><span className="caption-icon">↗</span><div><strong>Better leads. Less guesswork.</strong><small>Public data, made more useful.</small></div></div></div></div></section>
      <div className="trust-strip"><div className="landing-wrap trust-grid"><div><strong>FMCSA</strong><span>Public data sources</span></div><div><strong>50 states</strong><span>Search by location</span></div><div><strong>CSV export</strong><span>Take your leads with you</span></div><div><strong>GoshBuzz</strong><span>Built for opportunity</span></div></div></div>
      <section id="how-it-works" className="landing-section landing-wrap"><div className="section-heading"><div><span className="eyebrow">A SMARTER WAY TO PROSPECT</span><h2>Less digging.<br />More doing.</h2></div><p>From raw public records to a more focused prospect list. Get closer to the carriers that fit your business in three simple steps.</p></div>
        <div className="steps-grid"><article><span className="step-number">01</span><h3>Choose your opportunity</h3><p>Explore carriers by insurance effective or expiry dates to research new business and renewal opportunities.</p></article><article><span className="step-number">02</span><h3>Make it yours</h3><p>Use state, cargo and operation filters to narrow the results to the carriers you want to reach.</p></article><article><span className="step-number">03</span><h3>Take the next step</h3><p>Review the available carrier details and download a CSV for your outreach workflow.</p></article></div>
      </section>
      <section className="audience-section"><div className="landing-wrap audience-grid"><div><span className="eyebrow">MADE FOR THE TRUCKING ECOSYSTEM</span><h2>One search.<br /><em>More opportunities.</em></h2><p>Whether you help carriers get insured, financed, compliant, or on the road, a better starting list can make all the difference.</p><a href="/tool" className="text-link">Explore the lead tool →</a></div><div className="audience-tags"><span>Insurance agents ↗</span><span>Factoring providers ↗</span><span>Dispatch services ↗</span><span>ELD &amp; technology ↗</span><span>Freight brokers ↗</span><span>Compliance teams ↗</span></div></div></section>
      <section id="pricing" className="landing-section landing-wrap"><div className="section-heading"><div><span className="eyebrow">SIMPLE, ACCESSIBLE PRICING</span><h2>More opportunity.<br />Less overhead.</h2></div><p>Our planned tiers are designed to make carrier prospecting accessible, from your first search to your daily workflow.</p></div>
        <div className="pricing-grid">{plans.map(plan => <article key={plan.name} className={`plan-card${plan.featured ? ' plan-card--featured' : ''}`}><div className="plan-top"><span>{plan.name}</span>{plan.featured && <small>GREAT FOR GROWTH</small>}</div><div className="plan-price">{plan.price}<span>{plan.suffix}</span></div><h3>{plan.amount}</h3><p>{plan.detail}</p><ul>{plan.features.map(feature => <li key={feature}><span>✓</span>{feature}</li>)}</ul>{plan.href ? <a className="plan-button" href={plan.href}>{plan.cta} →</a> : <span className="plan-button plan-button--disabled">Coming soon</span>}</article>)}</div>
        <p className="pricing-disclaimer">These are planned tiers. Paid checkout, accounts and plan limits are not live yet; no payment is collected. The current tool is available to explore while we build the plans. Results and fields depend on source data and request limits.</p>
      </section>
      <section id="faq" className="faq-section"><div className="landing-wrap faq-grid"><div><span className="eyebrow">GOOD TO KNOW</span><h2>Questions?<br />We have answers.</h2><p>The essentials on trucking leads, data and getting started.</p></div><div className="faq-list">{FAQS.map(({q,a}) => <details key={q}><summary>{q}<span>+</span></summary><p>{a}</p></details>)}</div></div></section>
      <section className="landing-wrap final-cta"><div><span className="eyebrow">LET'S GET MOVING</span><h2>Ready to find your<br />next opportunity?</h2><p>Turn public carrier data into a starting point for your next conversation.</p></div><a href="/tool" className="landing-button">Explore trucking leads →</a></section>
    </main>
    <footer className="landing-footer"><div className="landing-wrap footer-grid"><div><a href="/" className="landing-brand"><Image src="/logo-192.png" width={48} height={48} alt="" /><span><strong>FREE TRUCKING LEADS</strong><small>by GoshBuzz</small></span></a><p>Carrier data, made more useful.</p></div><div><strong>Explore</strong><a href="/tool">Lead tool</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></div><div><strong>Our sources</strong><a href="https://www.fmcsa.dot.gov/" target="_blank" rel="noreferrer">FMCSA ↗</a><a href="https://data.transportation.gov/" target="_blank" rel="noreferrer">US DOT Open Data ↗</a><a href="https://goshbuzz.com" target="_blank" rel="noreferrer">GoshBuzz ↗</a></div></div><div className="landing-wrap footer-bottom">© {new Date().getFullYear()} GoshBuzz. Not affiliated with or endorsed by FMCSA. Verify records independently before use.</div></footer>
  </div>;
}
