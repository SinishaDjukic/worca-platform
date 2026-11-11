import { describe, expect, it } from 'vitest';
import { inlineHtml, notesHtml, notesText } from '../../../packages/platform/src/control/newsletter/notes';

/** The deployment's own domains: links to them (and GitHub) are kept. */
const SITE = { linkDomains: ['app.worca.dev', 'worca.run', 'worca.dev'] };

// GitHub's generated release body, as the release workflow sends it.
const NOTES = [
  "## What's Changed",
  '* A stop ends the container with exit 0 by @SinishaDjukic in https://github.com/SinishaDjukic/worca-cc/pull/610',
  '* Broker key page: `__Host-` CSRF cookie over https by @SinishaDjukic in https://github.com/SinishaDjukic/worca-cc/pull/612',
  '',
  '## New Contributors',
  '* @someone made their first contribution in https://github.com/SinishaDjukic/worca-cc/pull/608',
  '',
  '**Full Changelog**: https://github.com/SinishaDjukic/worca-cc/compare/worca-app-v1.9.0...worca-app-v1.9.1',
].join('\n');

describe('release notes in newsletter mail', () => {
  it('renders headings, bullet lists, bold, inline code and GitHub links; no Markdown left', () => {
    const html = notesHtml(NOTES, SITE);
    expect(html).toContain('<h2');
    expect(html).toContain("What&#39;s Changed");
    expect((html.match(/<ul/g) ?? []).length).toBe(2);
    expect((html.match(/<li/g) ?? []).length).toBe(3);
    expect(html).toContain('href="https://github.com/SinishaDjukic/worca-cc/pull/610"');
    expect(html).toContain('>#610</a>');
    expect(html).toMatch(/<strong[^>]*>Full Changelog<\/strong>/);
    expect(html).toMatch(/<code[^>]*>__Host-<\/code>/);
    expect(html).not.toMatch(/##|^\* |\*\*/m);
  });

  it('plain text drops the Markdown marks and keeps bullets as dashes', () => {
    const text = notesText(NOTES);
    expect(text).toContain("What's Changed\n\n- A stop ends the container");
    expect(text).toContain('Full Changelog: https://github.com/');
    expect(text).not.toMatch(/##|\*\*|`/);
  });

  it('escapes everything and links only GitHub and Worca hosts', () => {
    const html = inlineHtml('<img src=x onerror=alert(1)> see https://evil.example/x and [docs](https://docs.worca.dev/a) and [bad](javascript:alert(1))', SITE);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('href="https://evil.example');
    expect(html).toContain('https://evil.example/x');
    expect(html).toContain('href="https://docs.worca.dev/a"');
    expect(html).not.toContain('href="javascript');
    // Quotes and angle brackets never get into an attribute.
    const q = inlineHtml('[x](https://github.com/a"onmouseover="alert(1)) https://github.com/b\'<svg>', SITE);
    const hrefs = [...q.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['https://github.com/a', 'https://github.com/b']);
    expect(q).not.toContain('<svg');
    expect(q).not.toMatch(/ onmouseover=/);
  });

  it('drops HTML comments and keeps ordinary paragraphs', () => {
    expect(notesHtml('<!-- generated -->\nFirst line\nsecond line\n\nNext', SITE)).toBe(notesHtml('First line\nsecond line\n\nNext', SITE));
    expect(notesHtml('First line\nsecond line', SITE)).toContain('First line<br>second line');
  });
});
