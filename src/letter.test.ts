import { afterEach, describe, expect, it } from 'vitest';
import { actionFor, renderLetter } from './letter.js';

/**
 * Basu's letter. What has to hold: whatever a person or a supplier typed goes
 * in as text, never as markup; a code is set where it can be read; a button
 * points at the live site, not at a path a mail client cannot open; and the
 * letter wears «Тансаг хар» as far as mail lets it — the charcoal head, one
 * crimson button, light paper.
 */

afterEach(() => {
  delete process.env['PUBLIC_ORIGIN'];
});

describe('the letter', () => {
  it('sets the code large, says what it is for, and escapes what it is given', () => {
    const html = renderLetter({
      preheader: 'Таны код 482913',
      title: 'Нэвтрэх код',
      paragraphs: ['<b>Хэрлэн</b> & мах'],
      code: '482913',
      note: 'Хэнд ч бүү хэлээрэй',
    });
    expect(html).toContain('482913');
    expect(html).toContain('Нэвтрэх код');
    expect(html).toContain('&lt;b&gt;Хэрлэн&lt;/b&gt; &amp; мах');
    expect(html).not.toContain('<b>Хэрлэн</b>');
    expect(html).toContain('Хэнд ч бүү хэлээрэй');
    // The code in Basu's condensed face, or the narrow cut that stands in for it.
    expect(html).toMatch(/<div style="font-family:'Noto Sans Display Condensed','Avenir Next Condensed','Arial Narrow'[^"]*">482913<\/div>/);
    // The picture comes from the live site, under the name the dark head took
    // (the old one is still in browsers for a month), and says what it was when
    // it is not shown.
    expect(html).toContain('src="https://basu.burzai.cloud/brand/email/banner-dark.jpg"');
    expect(html).toContain('alt="Basu"');
    expect(html).toContain('basuappmn@gmail.com');
  });

  it('lets the promises at its foot break between them, so it is no wider than a phone', () => {
    const html = renderLetter({ preheader: 'x', title: 'Нэвтрэх код', paragraphs: ['x'], code: '482913' });
    const foot = /<td[^>]*>(<span style="[^"]*white-space:nowrap[^"]*">[\s\S]*?)<\/td>/.exec(html)?.[1] ?? '';
    // Each promise stays whole; what joins them is a space a line may break at,
    // and no dot to be left hanging at the end of a line.
    expect(foot.match(/white-space:nowrap/g)).toHaveLength(3);
    expect(foot.split('</span> <span')).toHaveLength(3);
    expect(foot).not.toMatch(/<\/span>[^<]*(&nbsp;| )[^<]*<span/);
    expect(foot).not.toContain('·');
  });

  it('points its button at the site, wherever the site lives', () => {
    process.env['PUBLIC_ORIGIN'] = 'https://example.mn/';
    const html = renderLetter({ preheader: 'x', title: 'Идэш баталгаажлаа', paragraphs: ['x'], action: actionFor('idesh.paid', 'abc') });
    expect(html).toContain('href="https://example.mn/orders/abc"');
    expect(html).toContain('Захиалгаа харах');
    expect(html).toContain('src="https://example.mn/brand/email/banner-dark.jpg"');
  });

  it('wears the charcoal head and one crimson button on paper that stays light', () => {
    const html = renderLetter({
      preheader: 'x',
      title: 'Идэш цуцлагдлаа',
      paragraphs: ['Идэш №7001 цуцлагдлаа.'],
      action: actionFor('idesh.cancelled', 'o1'),
      note: 'x',
    });
    // The head is the site's charcoal, under the picture of it.
    expect(html).toMatch(/<td bgcolor="#100D0C" style="background:#100D0C;[^"]*">\s*<img src="[^"]*\/banner-dark\.jpg"/);
    // The paper stays light, and asks the clients that listen not to darken it.
    expect(html).toContain('<meta name="color-scheme" content="light only">');
    expect(html).toContain('bgcolor="#FFFFFF"');
    // One button, crimson with white words, drawn by its cell, so Outlook,
    // which pads no link, still draws a button.
    expect(html.match(/#D21F3C/g)).toHaveLength(2);
    expect(html).toMatch(/<td align="center" bgcolor="#D21F3C" style="[^"]*mso-padding-alt:[^"]*">\s*<a href="https:\/\/basu\.burzai\.cloud\/orders\/o1" style="[^"]*color:#FFFFFF/);
    // The note is set apart by a gold rule, not filled with a colour.
    expect(html).toContain('border-left:3px solid #C9A96E');
    // Every colour is one of «Тансаг хар»'s, or the light paper's — nothing
    // left from before — and none of them is a variable a mail client drops.
    const palette = ['#100D0C', '#F6F0E8', '#D21F3C', '#C9A96E', '#140F0E', '#4A423E', '#6A605A', '#E8E1D8', '#F6F2EC', '#F4F1EC', '#FFFFFF'];
    for (const colour of new Set(html.match(/#[0-9A-Fa-f]{6}\b/g))) expect(palette).toContain(colour);
    expect(html).not.toContain('var(');
    expect(html).not.toContain('<style');
    // No slogan in the head: the same head opens a cancellation.
    expect(html).not.toContain('Шинэ мах');
  });

  it('gives each kind of notification its own next step', () => {
    expect(actionFor('idesh.ready', 'o1')).toEqual({ label: 'Захиалгаа харах', url: '/orders/o1' });
    expect(actionFor('supplier.order', 'o1')?.url).toBe('/supplier');
    expect(actionFor('org.member', 'g1')?.url).toBe('/dashboard');
    expect(actionFor('order.cooking', 'o1')?.url).toBe('/home');
    expect(actionFor('auth.otp', null)).toBeUndefined();
  });
});
