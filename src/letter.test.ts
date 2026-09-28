import { afterEach, describe, expect, it } from 'vitest';
import { actionFor, renderLetter } from './letter.js';

/**
 * Basu's letter. What has to hold: whatever a person or a supplier typed goes
 * in as text, never as markup; a code is set where it can be read; a button
 * points at the live site, not at a path a mail client cannot open.
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
    // The picture comes from the live site, and says what it was when it is not shown.
    expect(html).toContain('src="https://basu.burzai.cloud/brand/email/banner.jpg"');
    expect(html).toContain('alt="Шинэ мах. Эцсийн үнэ."');
    expect(html).toContain('basuappmn@gmail.com');
  });

  it('points its button at the site, wherever the site lives', () => {
    process.env['PUBLIC_ORIGIN'] = 'https://example.mn/';
    const html = renderLetter({ preheader: 'x', title: 'Идэш баталгаажлаа', paragraphs: ['x'], action: actionFor('idesh.paid', 'abc') });
    expect(html).toContain('href="https://example.mn/orders/abc"');
    expect(html).toContain('Захиалгаа харах');
  });

  it('gives each kind of notification its own next step', () => {
    expect(actionFor('idesh.ready', 'o1')).toEqual({ label: 'Захиалгаа харах', url: '/orders/o1' });
    expect(actionFor('supplier.order', 'o1')?.url).toBe('/supplier');
    expect(actionFor('org.member', 'g1')?.url).toBe('/dashboard');
    expect(actionFor('order.cooking', 'o1')?.url).toBe('/home');
    expect(actionFor('auth.otp', null)).toBeUndefined();
  });
});
