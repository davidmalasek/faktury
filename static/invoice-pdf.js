/* PDF faktury (pdfmake) a QR Platba. */
'use strict';

const Fmt = {
  money(v, currency = true) {
    const [int, dec] = Math.abs(Number(v) || 0).toFixed(2).split('.');
    const s = (v < 0 ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + dec;
    return currency ? s + ' Kč' : s;
  },
  money0(v) {
    const n = Math.round(Number(v) || 0);
    return (n < 0 ? '-' : '') + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + '\u00a0Kč';
  },
  qty(v) {
    return String(+Number(v).toFixed(4)).replace('.', ',');
  },
  date(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${+d}. ${+m}. ${y}`;
  },
  iban(iban) {
    return (iban || '').replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
  },
};

/** "19-2000145399/0800" → { prefix: "19", number: "2000145399", bank: "0800" } */
function parseCzAccount(account) {
  const m = String(account || '').replace(/\s/g, '').match(/^(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})$/);
  return m ? { prefix: m[1] || '', number: m[2], bank: m[3] } : null;
}

/** Kontrola čísla účtu podle ČNB (vážený součet dělitelný 11). */
function czAccountValid(account) {
  const a = parseCzAccount(account);
  if (!a) return false;
  const w = [6, 3, 7, 9, 10, 5, 8, 4, 2, 1];
  const ok = s => s.padStart(10, '0').split('').reduce((sum, d, i) => sum + d * w[i], 0) % 11 === 0;
  return ok(a.prefix || '0') && ok(a.number);
}

/** Převod českého čísla účtu na IBAN. */
function czIban(account) {
  const a = parseCzAccount(account);
  if (!a) return '';
  const bban = a.bank + a.prefix.padStart(6, '0') + a.number.padStart(10, '0');
  const check = 98n - (BigInt(bban + '123500') % 97n); // 'CZ' = 12 35
  return 'CZ' + String(check).padStart(2, '0') + bban;
}

/** Text QR Platby (formát SPAYD, kterému rozumí české bankovní aplikace). */
function spayd(inv) {
  const iban = (inv.supplier.iban || czIban(inv.supplier.account)).replace(/\s/g, '');
  if (!iban || !(inv.total > 0)) return null;
  const plain = (s, max) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\*/g, ' ').trim().slice(0, max);
  const parts = ['SPD', '1.0', 'ACC:' + iban, 'AM:' + inv.total.toFixed(2), 'CC:CZK'];
  if (inv.vs) parts.push('X-VS:' + inv.vs);
  parts.push('DT:' + inv.due_date.replace(/-/g, ''));
  if (inv.supplier.name) parts.push('RN:' + plain(inv.supplier.name, 35));
  parts.push('MSG:' + plain('Faktura ' + inv.number, 60));
  return parts.join('*');
}

function invoiceDocument(inv) {
  const s = inv.supplier, c = inv.customer;
  const gray = '#6b7280', line = '#d9dce1';
  const width = 595.28 - 2 * 50;
  const iban = s.iban || czIban(s.account);
  const qr = spayd(inv);

  const label = text => ({ text: text.toUpperCase(), fontSize: 7.5, color: gray, characterSpacing: 0.6, margin: [0, 0, 0, 5] });
  const rule = (top = 0, bottom = 0) => ({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.6, lineColor: line }],
    margin: [0, top, 0, bottom],
  });
  const party = p => [
    { text: p.name, bold: true, fontSize: 11, margin: [0, 0, 0, 2] },
    p.street,
    [p.zip, p.city].filter(Boolean).join(' '),
    p.country,
    p.ico && { text: `IČO: ${p.ico}`, margin: [0, 4, 0, 0] },
    p.dic && `DIČ: ${p.dic}`,
  ].filter(Boolean);
  const pairs = (rows, labelWidth) => ({
    width: '*',
    table: { widths: [labelWidth, '*'], body: rows.filter(r => r[1]).map(([k, v]) => [{ text: k, color: gray }, { text: v, noWrap: true }]) },
    layout: { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 4, paddingTop: () => 2, paddingBottom: () => 2 },
  });

  const right = { alignment: 'right' };
  const head = t => ({ text: t, fontSize: 7.5, color: gray, characterSpacing: 0.4 });
  const items = {
    table: {
      headerRows: 1,
      widths: ['*', 'auto', 'auto', 'auto'],
      body: [
        [head('POPIS'), { ...head('MNOŽSTVÍ'), ...right }, { ...head('CENA ZA JEDN.'), ...right }, { ...head('CELKEM'), ...right }],
        ...inv.items.map(it => [
          it.description,
          { text: `${Fmt.qty(it.quantity)} ${it.unit || ''}`.trim(), ...right, noWrap: true },
          { text: Fmt.money(it.price, false), ...right, noWrap: true },
          { text: Fmt.money(it.amount, false), ...right, noWrap: true },
        ]),
      ],
    },
    layout: {
      hLineWidth: (i, node) => (i === 0 ? 0 : i === 1 || i === node.table.body.length ? 0.8 : 0.4),
      vLineWidth: () => 0,
      hLineColor: () => line,
      paddingLeft: i => (i === 0 ? 0 : 12),
      paddingRight: (i, node) => (i === node.table.widths.length - 1 ? 0 : 12),
      paddingTop: () => 6,
      paddingBottom: () => 6,
    },
  };

  const totals = {
    columns: [
      qr
        ? { width: 'auto', stack: [{ qr, fit: 104, eccLevel: 'M' }, { text: 'QR Platba', fontSize: 7.5, color: gray, margin: [3, 2, 0, 0] }] }
        : { width: 'auto', text: '' },
      {
        width: '*',
        stack: [
          { text: 'Celkem k úhradě', color: gray, ...right },
          { text: Fmt.money(inv.total), fontSize: 20, bold: true, margin: [0, 2, 0, 6], ...right },
          s.vat_note ? { text: s.vat_note, color: gray, ...right } : '',
        ],
      },
    ],
    margin: [0, 18, 0, 0],
  };

  return {
    pageSize: 'A4',
    pageMargins: [50, 50, 50, 60],
    info: { title: `Faktura ${inv.number}`, author: s.name },
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: '#111827', lineHeight: 1.25 },
    watermark: inv.status === 'cancelled' ? { text: 'STORNOVÁNO', color: '#b91c1c', opacity: 0.12, bold: true } : undefined,
    content: [
      {
        columns: [
          { text: 'Faktura', fontSize: 24, bold: true },
          { stack: [{ ...label('Číslo faktury'), ...right }, { text: inv.number, fontSize: 14, bold: true, ...right }] },
        ],
        margin: [0, 0, 0, 30],
      },
      {
        columns: [
          { width: 210, stack: [label('Dodavatel'), ...party(s), s.registration ? { text: s.registration, fontSize: 8, color: gray, margin: [0, 4, 0, 0] } : ''] },
          { stack: [label('Odběratel'), ...party(c)] },
        ],
        columnGap: 30,
      },
      rule(24, 10),
      {
        columns: [
          { ...pairs([['Datum vystavení', Fmt.date(inv.issue_date)], ['Datum splatnosti', Fmt.date(inv.due_date)], ['Způsob platby', 'Převodem']], 92), width: 210 },
          pairs([['Bankovní účet', s.account], ['IBAN', Fmt.iban(iban)], ['Variabilní symbol', inv.vs]], 86),
        ],
        columnGap: 30,
      },
      rule(10, 24),
      items,
      totals,
      inv.note ? { stack: [label('Poznámka'), inv.note], margin: [0, 28, 0, 0] } : '',
      s.footer_note ? { text: s.footer_note, color: gray, margin: [0, 28, 0, 0] } : '',
    ],
    footer: (page, pages) => ({
      columns: [
        { text: [s.email, s.phone, s.web].filter(Boolean).join('   ·   '), color: gray },
        { text: pages > 1 ? `${page} / ${pages}` : '', color: gray, alignment: 'right', width: 40 },
      ],
      fontSize: 8,
      margin: [50, 20, 50, 0],
    }),
  };
}

function invoicePdfBlob(inv) {
  return new Promise(resolve => pdfMake.createPdf(invoiceDocument(inv)).getBlob(resolve));
}
