// Release notes in newsletter mail. The release hook sends GitHub's release body: Markdown with
// "## What's Changed", "* PR title by @someone in https://github.com/…/pull/12" bullets and a
// "**Full Changelog**: https://github.com/…/compare/…" line. Rendered here as a small, safe
// subset: headings, bullet lists, bold, inline code and links. Everything is escaped first; PR
// titles come from contributors, so links are kept only to GitHub and the deployment's own sites.
import type { Site } from '../../shared/site';
import { a, codeSpan, esc, h2, ownHost, p, strong, ul } from '../auth/mail-layout';

type Links = Pick<Site, 'linkDomains'>;

/** Hosts release notes may link to; any other URL stays plain text. */
function linkable(url: string, site: Links): boolean {
  if (ownHost(url, site.linkDomains)) return true;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'github.com' || hostname.endsWith('.github.com'));
  } catch {
    return false;
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"'.,;:!?)\]]/g;

/** One line of Markdown text → escaped HTML with bold, inline code and links. */
export function inlineHtml(text: string, site: Links): string {
  // Code spans first, so nothing inside them is treated as Markdown.
  const parts = text.split(/(`[^`\n]+`)/);
  return parts
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return codeSpan(esc(part.slice(1, -1)));
      let out = '';
      let last = 0;
      // [label](url) and bare URLs, in order of appearance.
      const re = new RegExp(`\\[([^\\]\\n]{1,200})\\]\\((https?:\\/\\/[^\\s)<>"']+)\\)|${URL_RE.source}`, 'g');
      for (const m of part.matchAll(re)) {
        out += emphasis(esc(part.slice(last, m.index)));
        const [whole, label, href] = m;
        const url = href ?? whole;
        // a() escapes href and label; the href is also rebuilt from the parsed URL.
        const safeHref = linkable(url, site) ? new URL(url).href : null;
        out += safeHref ? a(safeHref, label ?? shortUrl(url)) : esc(label ?? whole);
        last = m.index! + whole.length;
      }
      return out + emphasis(esc(part.slice(last)));
    })
    .join('');
}

/** `**bold**` in already-escaped text. */
const emphasis = (escaped: string) => escaped.replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => strong(t));

/** github.com/owner/repo/pull/12 → "#12"; other URLs keep their host and path. */
function shortUrl(url: string): string {
  const pr = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)$/.exec(url);
  if (pr) return `#${pr[1]}`;
  return url.replace(/^https?:\/\//, '');
}

type Block = { kind: 'h'; text: string } | { kind: 'li'; items: string[] } | { kind: 'p'; lines: string[] };

function blocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const last = out[out.length - 1];
    const heading = /^#{1,6}\s+(.+)$/.exec(line.trim());
    const item = /^\s*[*+-]\s+(.+)$/.exec(line);
    if (!line.trim()) {
      out.push({ kind: 'p', lines: [] });
    } else if (heading) {
      out.push({ kind: 'h', text: heading[1]!.replace(/\s+#+\s*$/, '') });
    } else if (item) {
      if (last?.kind === 'li') last.items.push(item[1]!);
      else out.push({ kind: 'li', items: [item[1]!] });
    } else if (last?.kind === 'p') {
      last.lines.push(line.trim());
    } else {
      out.push({ kind: 'p', lines: [line.trim()] });
    }
  }
  return out.filter((b) => b.kind !== 'p' || b.lines.length > 0);
}

/** Release notes Markdown → mail HTML. */
export function notesHtml(md: string, site: Links): string {
  const inline = (t: string) => inlineHtml(t, site);
  return blocks(md)
    .map((b) => (b.kind === 'h' ? h2(inline(b.text)) : b.kind === 'li' ? ul(b.items.map(inline)) : p(b.lines.map(inline).join('<br>'))))
    .join('');
}

/** Release notes Markdown → the plain-text part: no #, ** or backticks; bullets as "- ". */
export function notesText(md: string): string {
  const plain = (t: string) => t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
  return blocks(md)
    .map((b) => (b.kind === 'h' ? plain(b.text) : b.kind === 'li' ? b.items.map((i) => `- ${plain(i)}`).join('\n') : b.lines.map(plain).join('\n')))
    .join('\n\n');
}
