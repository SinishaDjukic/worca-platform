// Who runs this deployment and where its public pages are, as both Workers read it from their
// vars (set from PlatformConfig.branding, src/shared/config.ts). Every field but the app origin
// is optional: a deployment that sets none gets mail and pages without those links or lines.

/** The vars siteOf() reads; both Workers' Env have them. */
export interface SiteVars {
  APP_ORIGIN: string;
  INSTANCE_DOMAIN: string;
  PRODUCT_NAME?: string;
  SERVICE_NAME?: string;
  MAIL_LOGO_SIZE?: string;
  OPERATOR_NAME?: string;
  WEBSITE_URL?: string;
  ABOUT_URL?: string;
  CONTACT_EMAIL?: string;
  ABUSE_EMAIL?: string;
  ABUSE_URL?: string;
  PRIVACY_URL?: string;
  TERMS_URL?: string;
  LEGAL_URL?: string;
}

export interface Site {
  /** The control plane and console, without a trailing slash. */
  appOrigin: string;
  /** Instances live under it (INSTANCE_DOMAIN). */
  instanceDomain: string;
  /** Page titles, the logo's text alternative, mail: PRODUCT_NAME, else "Worca". */
  productName: string;
  /** The hosted service in page footers ("… · What is this?"): SERVICE_NAME, else "<productName> hosted". */
  serviceName: string;
  /** Pixel size of the mail logo: MAIL_LOGO_SIZE ("148x44"), else 148×44 (Worca's). */
  mailLogo: { width: number; height: number };
  /** Mail footers name it as the sender. */
  operatorName: string | null;
  websiteUrl: string | null;
  /** "What is this?": ABOUT_URL, else the website, else the app. */
  aboutUrl: string;
  contactEmail: string | null;
  /** ABUSE_EMAIL, else the contact address. */
  abuseEmail: string | null;
  abuseUrl: string | null;
  /** Legal pages for mail footers, in this order: Privacy, Terms, Legal; unset ones left out. */
  legal: readonly (readonly [label: string, href: string])[];
  /**
   * Domains whose URLs (the domain and its subdomains) mail turns into links: the app's host,
   * the instance domain and the website's host. Any other URL in mail stays plain text.
   */
  linkDomains: readonly string[];
}

/** The product being hosted; deployments may name their service otherwise (branding.productName). */
export const DEFAULT_PRODUCT_NAME = 'Worca';

function logoSize(v: string | undefined): { width: number; height: number } {
  const m = /^(\d{1,3})x(\d{1,3})$/.exec(v?.trim() ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 148, height: 44 };
}

const clean = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

function hostname(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function siteOf(env: SiteVars): Site {
  const appOrigin = env.APP_ORIGIN.replace(/\/+$/, '');
  const productName = clean(env.PRODUCT_NAME) ?? DEFAULT_PRODUCT_NAME;
  const websiteUrl = clean(env.WEBSITE_URL);
  const contactEmail = clean(env.CONTACT_EMAIL);
  const legal: (readonly [string, string])[] = [];
  for (const [label, href] of [['Privacy', env.PRIVACY_URL], ['Terms', env.TERMS_URL], ['Legal', env.LEGAL_URL]] as const) {
    const url = clean(href);
    if (url) legal.push([label, url]);
  }
  const linkDomains: string[] = [];
  for (const d of [hostname(appOrigin), env.INSTANCE_DOMAIN.toLowerCase(), hostname(websiteUrl)]) if (d && !linkDomains.includes(d)) linkDomains.push(d);
  return {
    appOrigin,
    instanceDomain: env.INSTANCE_DOMAIN.toLowerCase(),
    productName,
    serviceName: clean(env.SERVICE_NAME) ?? `${productName} hosted`,
    mailLogo: logoSize(env.MAIL_LOGO_SIZE),
    operatorName: clean(env.OPERATOR_NAME),
    websiteUrl,
    aboutUrl: clean(env.ABOUT_URL) ?? websiteUrl ?? appOrigin,
    contactEmail,
    abuseEmail: clean(env.ABUSE_EMAIL) ?? contactEmail,
    abuseUrl: clean(env.ABUSE_URL),
    legal,
    linkDomains,
  };
}

/** The website's host for running text ("the form on example.com"), or null without a website. */
export const websiteHost = (site: Site): string | null => hostname(site.websiteUrl);
