'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const app = $('#app');

const UNITS = ['ks', 'hod', 'den', 'měs.', 'km', 'm²', 'paušál'];
const CUSTOMER_FIELDS = ['name', 'ico', 'dic', 'street', 'city', 'zip', 'country', 'email'];
const SUPPLIER_FIELDS = ['name', 'street', 'city', 'zip', 'ico', 'registration', 'account', 'iban', 'email', 'phone', 'web', 'vat_note', 'footer_note'];
const VAT_LIMIT = 2000000; // obrat za kalendářní rok, nad který se neplátce musí registrovat k DPH
// Rozhodná částka pro vedlejší SVČ (ČSSZ): když zisk za rok dosáhne této částky, platí se sociální pojištění.
// Každý rok doplnit novou hodnotu (zveřejňuje se na podzim předchozího roku).
const SOCIAL_LIMITS = { 2025: 111736, 2026: 117521 };
const EXPENSE_RATES = [
  [80, '80 % – řemeslné živnosti'],
  [60, '60 % – ostatní živnosti'],
  [40, '40 % – svobodná povolání, autorská práva'],
  [0, 'Skutečné výdaje'],
];
const STATUS_FILTERS = [
  ['vse', 'Vše'],
  ['ceka', 'Čeká na platbu'],
  ['po-splatnosti', 'Po splatnosti'],
  ['zaplaceno', 'Zaplacené'],
  ['storno', 'Stornované'],
];

// ---------- pomocné ----------

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body instanceof Blob) {
    init.body = body;
    init.headers['Content-Type'] = body.type || 'application/pdf';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch('/api/' + path, init);
  } catch {
    throw new Error('Aplikace neběží – spusť ji znovu ikonou Faktury.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Chyba ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isError ? 6000 : 2500);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/** Spustí akci; tlačítko mezitím zablokuje (a po chvíli ukáže kolečko), chybu ukáže uživateli. */
async function attempt(fn, button) {
  let shownAt = 0;
  let timer;
  if (button) {
    button.disabled = true;
    timer = setTimeout(() => {
      button.classList.add('loading');
      shownAt = performance.now();
    }, 150);
  }
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (button) {
      clearTimeout(timer);
      if (shownAt) await wait(Math.max(0, 350 - (performance.now() - shownAt)));
      button.classList.remove('loading');
      button.disabled = false;
    }
  }
}

function isoDate(d = new Date()) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
function parseNum(v) {
  const n = parseFloat(String(v ?? '').replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const decimalInput = v => (v === '' || v == null ? '' : String(v).replace('.', ','));
const byName = (a, b) => a.name.localeCompare(b.name, 'cs', { sensitivity: 'base' });
const sum = list => list.reduce((s, i) => s + i.total, 0);
const sumAmount = list => list.reduce((s, i) => s + i.amount, 0); // příjmy bez faktury
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
const setTitle = t => (document.title = t ? `${t} – Faktury` : 'Faktury');

function statusOf(inv) {
  if (inv.status === 'paid') return ['paid', 'Zaplaceno'];
  if (inv.status === 'cancelled') return ['cancelled', 'Stornováno'];
  if (inv.due_date < isoDate()) return ['overdue', 'Po splatnosti'];
  return ['issued', 'Čeká na platbu'];
}
const statusLabel = inv => {
  const [cls, text] = statusOf(inv);
  return `<span class="status ${cls}">${text}</span>`;
};
const contactLabel = c => (c.ico ? `${c.name} (IČO ${c.ico})` : c.name);
const pickCustomer = c => Object.fromEntries(CUSTOMER_FIELDS.map(k => [k, c[k] || '']));
const sameData = (a, b, keys) => keys.every(k => String(a?.[k] ?? '') === String(b?.[k] ?? ''));
const addressLines = p => [p.street, [p.zip, p.city].filter(Boolean).join(' '), p.country].filter(Boolean);
const archivUrl = (file, version) => `/archiv/${file.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(version || '')}`;
const pdfUrl = inv => archivUrl(inv.pdf_file, inv.updated_at);
const pdfFileName = inv => `Faktura-${inv.number.replace(/[^\w.-]+/g, '-')}.pdf`;
const missingSettings = s => !s.name || !s.ico || !s.account;

async function storePdf(inv) {
  return api(`invoices/${inv.id}/pdf`, { method: 'PUT', body: await invoicePdfBlob(inv) });
}

function field(label, attrs, value = '', { cls = 'c3', type = 'text' } = {}) {
  return `<label class="${cls}">${esc(label)}<input ${attrs} type="${type}" value="${esc(value)}"></label>`;
}
function icoField(attrs, value = '', cls = 'c2') {
  return `<label class="${cls}">IČO<span class="inline"><input ${attrs} value="${esc(value)}" inputmode="numeric" spellcheck="false" placeholder="12345678">` +
    `<button type="button" class="btn" data-ares>Načíst z ARES</button></span></label>`;
}
async function loadAres(ico) {
  if (!ico.trim()) throw new Error('Nejdřív zadej IČO.');
  const data = await api('ares/' + encodeURIComponent(ico.trim()));
  toast('Údaje načteny z ARES');
  return data;
}

/** Dotaz na datum úhrady. Vrátí [{id, paid_date}] nebo null, když uživatel zruší. */
function askPaid(invoices) {
  const today = isoDate();
  const single = invoices.length === 1;
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'paid-title');
  dialog.innerHTML = `
    <form method="dialog">
      <h2 id="paid-title">Označit jako ${single ? 'zaplacenou' : 'zaplacené'}</h2>
      <p class="muted" style="margin:0">${single ? `Faktura ${esc(invoices[0].number)}` : plural(invoices.length, 'faktura', 'faktury', 'faktur')} · ${Fmt.money(sum(invoices))}</p>
      <div class="choices" role="radiogroup" aria-label="Datum úhrady">
        <label><input type="radio" name="when" value="today" checked> Dnes <span class="muted">${Fmt.date(today)}</span></label>
        <label><input type="radio" name="when" value="due"> ${single ? `K datu splatnosti <span class="muted">${Fmt.date(invoices[0].due_date)}</span>` : 'K datu splatnosti každé faktury'}</label>
        <label><input type="radio" name="when" value="date"> Jiné datum <input type="date" name="date" value="${today}" aria-label="Jiné datum úhrady"></label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" data-cancel>Zrušit</button>
        <button class="btn primary" value="ok">Označit</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = $('form', dialog);
  form.elements.date.addEventListener('focus', () => (form.elements.when.value = 'date'));
  $('[data-cancel]', dialog).onclick = () => dialog.close();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const when = form.elements.when.value;
      const custom = form.elements.date.value;
      dialog.remove();
      if (dialog.returnValue !== 'ok') return resolve(null);
      if (when === 'date' && !custom) {
        toast('Vyber datum úhrady.', true);
        return resolve(null);
      }
      resolve(invoices.map(inv => ({
        id: inv.id,
        paid_date: when === 'today' ? today : when === 'due' ? (inv.due_date < today ? inv.due_date : today) : custom,
      })));
    });
    dialog.returnValue = '';
    dialog.showModal();
  });
}

/** Zeptá se na datum úhrady a označí faktury jako zaplacené; kolečko na tlačítku až po potvrzení. */
async function markPaid(invoices, button) {
  const changes = await askPaid(invoices);
  if (!changes) return;
  await attempt(async () => {
    await api('invoices/status', { method: 'POST', body: { changes } });
    toast(invoices.length === 1 ? 'Označeno jako zaplacené' : `${plural(invoices.length, 'faktura označena', 'faktury označeny', 'faktur označeno')} jako zaplacené`);
    router(false);
  }, button);
}

function invoiceRows(rows, { selectable = false } = {}) {
  return rows.map(i => `
    <tr data-href="#/faktura/${i.id}" data-id="${i.id}">
      ${selectable ? `<td class="sel">${i.status === 'issued' ? `<label><input type="checkbox" data-select="${i.id}" aria-label="Vybrat fakturu ${esc(i.number)}"></label>` : ''}</td>` : ''}
      <td class="strong nowrap"><a href="#/faktura/${i.id}" style="color:inherit">${esc(i.number)}</a>${i.imported ? '<span class="tag hide-sm">převzatá</span>' : ''}</td>
      <td>${esc(i.customer.name)}<div class="show-sm">${statusLabel(i)}</div></td>
      <td class="nowrap hide-sm">${Fmt.date(i.issue_date)}</td>
      <td class="nowrap hide-sm">${Fmt.date(i.due_date)}</td>
      <td class="num">${Fmt.money(i.total)}</td>
      <td class="hide-sm">${statusLabel(i)}</td>
    </tr>`).join('');
}
function invoiceTable(rows, opts = {}) {
  return `
    <div class="table-scroll"><table class="list">
      <thead><tr>
        ${opts.selectable ? '<th class="sel"><label><input type="checkbox" data-select-all aria-label="Vybrat všechny nezaplacené"></label></th>' : ''}
        <th>Číslo</th><th>Odběratel</th><th class="hide-sm">Vystaveno</th><th class="hide-sm">Splatnost</th><th class="num">Částka</th><th class="hide-sm">Stav</th>
      </tr></thead>
      <tbody>${invoiceRows(rows, opts)}</tbody>
      ${opts.footer ? `<tfoot><tr><td colspan="${opts.selectable ? 7 : 6}">${opts.footer}</td></tr></tfoot>` : ''}
    </table></div>`;
}

// ---------- přehled ----------

async function viewDashboard(params) {
  const [invoices, incomes, settings] = await Promise.all([api('invoices'), api('incomes'), api('settings')]);
  return () => {
    setTitle('Přehled');
    const today = isoDate();
    const thisYear = today.slice(0, 4);
    const thisMonth = Number(today.slice(5, 7)) - 1;
    const years = [...new Set([thisYear, ...invoices.map(i => i.issue_date.slice(0, 4)), ...incomes.map(i => i.date.slice(0, 4))])].sort();
    const year = years.includes(params.get('rok')) ? params.get('rok') : thisYear;
    const isCurrent = year === thisYear;

    const active = invoices.filter(i => i.status !== 'cancelled');
    const inYear = active.filter(i => i.issue_date.startsWith(year));
    const incomesInYear = incomes.filter(i => i.date.startsWith(year));
    const unpaid = active.filter(i => i.status === 'issued');
    const overdue = unpaid.filter(i => i.due_date < today);
    const byMonth = Array.from({ length: 12 }, (_, m) => inYear.filter(i => Number(i.issue_date.slice(5, 7)) === m + 1));
    const monthsSoFar = isCurrent ? thisMonth + 1 : 12;

    if (!invoices.length && !incomes.length) {
      app.innerHTML = `
        ${missingSettings(settings) ? '<div class="notice">Než vystavíš první fakturu, vyplň svoje údaje a číslo účtu v <a href="#/nastaveni">Nastavení</a>.</div>' : ''}
        <div class="page-head"><h1>Přehled</h1></div>
        <div class="card empty">Zatím tu nejsou žádné faktury.<br><a class="btn primary" href="#/faktura/nova">Vystavit první fakturu</a></div>`;
      return;
    }

    // odběratelé za rok
    const groups = new Map();
    for (const i of inYear) {
      const key = i.contact_id ? `c${i.contact_id}` : `n${i.customer.name}`;
      const g = groups.get(key) || { label: i.customer.name, value: 0, href: i.contact_id ? `#/kontakt/${i.contact_id}` : `#/faktury?rok=${year}&q=${encodeURIComponent(i.customer.name)}` };
      g.value += i.total;
      groups.set(key, g);
    }
    let customers = [...groups.values()].sort((a, b) => b.value - a.value);
    if (customers.length > 7) {
      const rest = customers.slice(6);
      customers = [...customers.slice(0, 6), { label: `Ostatní (${rest.length})`, value: rest.reduce((s, r) => s + r.value, 0), href: `#/faktury?rok=${year}` }];
    }

    const yearRows = years.slice().reverse().map(y => {
      const list = active.filter(i => i.issue_date.startsWith(y));
      return { y, count: list.length, total: sum(list), paid: sum(list.filter(i => i.status === 'paid')), other: sumAmount(incomes.filter(i => i.date.startsWith(y))) };
    });

    app.innerHTML = `
      ${missingSettings(settings) ? '<div class="notice">Doplň svoje údaje a číslo účtu v <a href="#/nastaveni">Nastavení</a>.</div>' : ''}
      <div class="page-head">
        <h1>Přehled</h1>
        <nav class="segmented" aria-label="Rok">${years.map(y => `<a href="#/prehled?rok=${y}" class="${y === year ? 'on' : ''}" ${y === year ? 'aria-current="page"' : ''}>${y}</a>`).join('')}</nav>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="k">Vyfakturováno ${isCurrent ? 'letos' : `v roce ${year}`}</div><div class="v">${Fmt.money0(sum(inYear))}</div><div class="d">${plural(inYear.length, 'faktura', 'faktury', 'faktur')}</div></div>
        ${isCurrent
          ? `<a class="kpi" href="#/faktury?rok=${year}&mesic=${thisMonth + 1}"><div class="k">${capitalize(MONTHS[thisMonth])}</div><div class="v">${Fmt.money0(sum(byMonth[thisMonth]))}</div><div class="d">${plural(byMonth[thisMonth].length, 'faktura', 'faktury', 'faktur')}</div></a>`
          : `<div class="kpi"><div class="k">Průměrně za měsíc</div><div class="v">${Fmt.money0(sum(inYear) / monthsSoFar)}</div><div class="d">za ${plural(monthsSoFar, 'měsíc', 'měsíce', 'měsíců')}</div></div>`}
        <a class="kpi" href="#/faktury?rok=vse&stav=ceka"><div class="k">Čeká na platbu</div><div class="v">${Fmt.money0(sum(unpaid))}</div><div class="d">${plural(unpaid.length, 'faktura', 'faktury', 'faktur')}</div></a>
        <a class="kpi" href="#/faktury?rok=vse&stav=po-splatnosti"><div class="k">Po splatnosti</div><div class="v${overdue.length ? ' bad' : ''}">${Fmt.money0(sum(overdue))}</div><div class="d">${plural(overdue.length, 'faktura', 'faktury', 'faktur')}</div></a>
      </div>
      <div class="dash-grid">
        <section class="card">
          <div class="card-head"><h2>Fakturace po měsících</h2><span class="muted">${year} · podle data vystavení</span></div>
          <div id="months"></div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Odběratelé</h2><span class="muted">${year}</span></div>
          <div id="customers">${customers.length ? '' : '<p class="muted">V tomto roce zatím nic.</p>'}</div>
        </section>
        ${socialCard({ year, isCurrent, active, unpaid, incomes: incomesInYear, settings })}
        <section class="card">
          <div class="card-head"><h2>Limit pro DPH</h2><span class="muted">${year}</span></div>
          ${meter(sum(inYear) + sumAmount(incomesInYear), VAT_LIMIT)}
          <p class="hint">Když obrat za kalendářní rok přesáhne 2&nbsp;000&nbsp;000&nbsp;Kč, musíš se registrovat k&nbsp;DPH.${incomesInYear.length ? ' Obrat zahrnuje i příjmy bez faktury.' : ''}</p>
        </section>
        ${incomesInYear.length ? `
          <section class="table-card wide">
            <div class="card-head"><h2>Příjmy bez faktury</h2><a class="btn" href="#/prijem/novy">Přidat</a></div>
            <div class="table-scroll"><table class="list">
              <thead><tr><th>Přijato</th><th>Od koho</th><th class="hide-sm">Popis</th><th class="num">Částka</th></tr></thead>
              <tbody>${incomesInYear.map(i => `
                <tr data-href="#/prijem/${i.id}">
                  <td class="nowrap">${Fmt.date(i.date)}</td>
                  <td class="strong"><a href="#/prijem/${i.id}" style="color:inherit">${esc(i.payer)}</a></td>
                  <td class="hide-sm muted">${esc(i.description)}</td>
                  <td class="num">${Fmt.money(i.amount)}</td>
                </tr>`).join('')}
              </tbody>
            </table></div>
          </section>` : ''}
        <section class="table-card wide">
          <table class="list">
            <thead><tr><th>Rok</th><th class="num">Faktur</th><th class="num">Vyfakturováno</th><th class="num">Zaplaceno</th>${incomes.length ? '<th class="num">Bez faktury</th>' : ''}</tr></thead>
            <tbody>${yearRows.map(r => `
              <tr data-href="#/prehled?rok=${r.y}" class="${r.y === year ? 'selected' : ''}">
                <td class="strong"><a href="#/prehled?rok=${r.y}" style="color:inherit">${r.y}</a></td>
                <td class="num">${r.count}</td><td class="num">${Fmt.money0(r.total)}</td><td class="num">${Fmt.money0(r.paid)}</td>${incomes.length ? `<td class="num">${Fmt.money0(r.other)}</td>` : ''}
              </tr>`).join('')}
            </tbody>
          </table>
        </section>
      </div>`;

    columnChart($('#months'), {
      year,
      current: isCurrent ? thisMonth : -1,
      months: byMonth.map((list, m) => ({ value: sum(list), count: list.length, href: `#/faktury?rok=${year}&mesic=${m + 1}` })),
    });
    if (customers.length) barList($('#customers'), customers);
  };
}

/** Karta „Sociální pojištění“: kolik ještě můžu přijmout, aby zisk nedosáhl rozhodné částky. */
function socialCard({ year, isCurrent, active, unpaid, incomes, settings }) {
  if (!settings.side_activity) return '';
  const head = `<div class="card-head"><h2>Sociální pojištění</h2><span class="muted">${year} · vedlejší činnost</span></div>`;
  const limit = SOCIAL_LIMITS[year];
  if (!limit) {
    return `<section class="card">${head}<p class="muted" style="margin:0">Rozhodnou částku pro rok ${year} zatím appka nezná.</p></section>`;
  }
  const rate = Number(settings.expense_rate) || 0;
  // Nejvyšší příjmy, při kterých zisk zůstane pod rozhodnou částkou (zisk = příjmy − paušál).
  const maxIncome = Math.floor((limit - 1) / (1 - rate / 100));
  // Počítá se podle data zaplacení – příjem patří do roku, kdy peníze přišly. Příjmy bez faktury taky.
  const received = sum(active.filter(i => i.status === 'paid' && (i.paid_date || '').startsWith(year))) + sumAmount(incomes);
  const pending = isCurrent ? sum(unpaid) : 0;
  const over = received > maxIncome;
  const left = maxIncome - received;

  const big = over
    ? `<div class="k">Limit je překročený o</div><div class="v bad">${Fmt.money0(-left)}</div>
       <div class="d">Za rok ${year} budeš sociální pojištění platit.</div>`
    : isCurrent
      ? `<div class="k">Letos ještě můžeš přijmout</div><div class="v">${Fmt.money0(left)}</div>
         <div class="d">a sociální pojištění za rok ${year} platit nebudeš.</div>`
      : `<div class="k">Pod limitem o</div><div class="v">${Fmt.money0(left)}</div>
         <div class="d">Za rok ${year} se sociální pojištění neplatí.</div>`;
  const legend = `<span class="keys"><span><i class="sw"></i>Přijato ${Fmt.money0(received)}</span>${pending > 0 && !over ? `<span><i class="sw pending"></i>Čeká ${Fmt.money0(pending)}</span>` : ''}</span>`;
  const warn = !over && received + pending > maxIncome
    ? `<p class="hint bad">Když ti letos přijdou i čekající platby, limit překročíš.</p>` : '';

  return `
    <section class="card social">
      ${head}
      <div class="kpi-inline">${big}</div>
      ${meter(received, maxIncome, { pending, label: 'Přijato', legend })}
      ${warn}
      <p class="hint">Sociální pojištění neplatíš, dokud zisk za rok nedosáhne ${Fmt.money0(limit)} (rozhodná částka ${year}).
        ${rate ? `Při paušálu ${rate} % to je nejvýš ${Fmt.money0(maxIncome)} přijatých plateb.` : 'Počítá se bez výdajů, takže skutečná rezerva je větší o tvoje výdaje.'}
        Počítají se platby podle data zaplacení${incomes.length ? ` včetně příjmů bez faktury (${Fmt.money0(sumAmount(incomes))})` : ''}. Paušál změníš v&nbsp;<a href="#/nastaveni">Nastavení</a>.</p>
    </section>`;
}

// ---------- faktury: seznam ----------

async function viewInvoices(params) {
  const invoices = await api('invoices');
  return () => {
    setTitle('Faktury');
    const today = isoDate();
    const thisYear = today.slice(0, 4);
    const years = [...new Set([thisYear, ...invoices.map(i => i.issue_date.slice(0, 4))])].sort().reverse();
    const f = {
      rok: params.get('rok') || (invoices.some(i => i.issue_date.startsWith(thisYear)) || !invoices.length ? thisYear : 'vse'),
      mesic: params.get('mesic') || '',
      stav: STATUS_FILTERS.some(([k]) => k === params.get('stav')) ? params.get('stav') : 'vse',
      q: params.get('q') || '',
    };
    const selected = new Set();

    app.innerHTML = `
      <div class="page-head">
        <h1>Faktury</h1>
        <div class="actions">
          <a class="btn" href="#/prijem/novy">Příjem bez faktury</a>
          <a class="btn primary" href="#/faktura/nova">Nová faktura</a>
        </div>
      </div>
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="Stav">${STATUS_FILTERS.map(([k, label]) => `<button type="button" data-stav="${k}" aria-pressed="false">${label}</button>`).join('')}</div>
        <span class="spacer"></span>
        <select id="rok" aria-label="Rok">${['vse', ...years].map(y => `<option value="${y}">${y === 'vse' ? 'Všechny roky' : y}</option>`).join('')}</select>
        <select id="mesic" aria-label="Měsíc"><option value="">Celý rok</option>${MONTHS.map((m, i) => `<option value="${i + 1}">${capitalize(m)}</option>`).join('')}</select>
        <input id="search" type="search" placeholder="Hledat…" aria-label="Hledat číslo nebo odběratele" autocomplete="off" spellcheck="false">
      </div>
      <div class="table-card" id="list"></div>
      <div class="bulkbar" id="bulkbar" hidden>
        <span class="count" id="bulk-count"></span>
        <button type="button" class="btn ghost" id="bulk-clear">Zrušit výběr</button>
        <button type="button" class="btn primary" id="bulk-paid">Označit jako zaplacené…</button>
      </div>`;

    if (!years.includes(f.rok)) f.rok = 'vse';
    $('#rok').value = f.rok;
    $('#mesic').value = f.mesic;
    $('#search').value = f.q;

    const matches = i => {
      const [cls] = statusOf(i);
      if (f.rok !== 'vse' && !i.issue_date.startsWith(f.rok)) return false;
      if (f.mesic && Number(i.issue_date.slice(5, 7)) !== Number(f.mesic)) return false;
      if (f.stav === 'ceka' && i.status !== 'issued') return false;
      if (f.stav === 'po-splatnosti' && cls !== 'overdue') return false;
      if (f.stav === 'zaplaceno' && i.status !== 'paid') return false;
      if (f.stav === 'storno' && i.status !== 'cancelled') return false;
      const q = f.q.toLowerCase();
      return !q || i.number.toLowerCase().includes(q) || i.customer.name.toLowerCase().includes(q) || (i.customer.ico || '').includes(q);
    };
    const syncUrl = () => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v && !(k === 'stav' && v === 'vse')) p.set(k, v);
      setHash(`#/faktury?${p}`);
    };
    const updateBulk = () => {
      const bar = $('#bulkbar');
      bar.hidden = selected.size === 0;
      $('#bulk-count').textContent = `Vybráno: ${plural(selected.size, 'faktura', 'faktury', 'faktur')}`;
      $$('tr[data-id]').forEach(tr => tr.classList.toggle('selected', selected.has(Number(tr.dataset.id))));
      const boxes = $$('[data-select]');
      const all = $('[data-select-all]');
      if (all) {
        all.checked = boxes.length > 0 && boxes.every(b => b.checked);
        all.indeterminate = !all.checked && boxes.some(b => b.checked);
      }
    };
    const draw = () => {
      const rows = invoices.filter(matches);
      $$('[data-stav]').forEach(b => {
        b.classList.toggle('on', b.dataset.stav === f.stav);
        b.setAttribute('aria-pressed', String(b.dataset.stav === f.stav));
      });
      for (const id of [...selected]) if (!rows.some(r => r.id === id && r.status === 'issued')) selected.delete(id);
      const active = rows.filter(i => i.status !== 'cancelled');
      $('#list').innerHTML = rows.length
        ? invoiceTable(rows, { selectable: true, footer: `${plural(rows.length, 'faktura', 'faktury', 'faktur')} · celkem ${Fmt.money(sum(active))}` })
        : `<div class="empty">${invoices.length ? 'Žádná faktura neodpovídá filtru.' : 'Zatím tu nejsou žádné faktury.<br><a class="btn primary" href="#/faktura/nova">Vystavit první fakturu</a>'}</div>`;
      $$('[data-select]').forEach(b => (b.checked = selected.has(Number(b.dataset.select))));
      updateBulk();
    };

    $$('[data-stav]').forEach(b => (b.onclick = () => {
      f.stav = b.dataset.stav;
      syncUrl();
      draw();
    }));
    $('#rok').onchange = e => {
      f.rok = e.target.value;
      syncUrl();
      draw();
    };
    $('#mesic').onchange = e => {
      f.mesic = e.target.value;
      syncUrl();
      draw();
    };
    $('#search').oninput = e => {
      f.q = e.target.value.trim();
      syncUrl();
      draw();
    };
    $('#list').addEventListener('change', e => {
      if (e.target.matches('[data-select-all]')) {
        $$('[data-select]').forEach(b => (e.target.checked ? selected.add(Number(b.dataset.select)) : selected.delete(Number(b.dataset.select))));
        $$('[data-select]').forEach(b => (b.checked = e.target.checked));
      } else if (e.target.matches('[data-select]')) {
        const id = Number(e.target.dataset.select);
        e.target.checked ? selected.add(id) : selected.delete(id);
      }
      updateBulk();
    });
    $('#bulk-clear').onclick = () => {
      selected.clear();
      $$('[data-select]').forEach(b => (b.checked = false));
      updateBulk();
    };
    $('#bulk-paid').onclick = e => markPaid(invoices.filter(i => selected.has(i.id)), e.currentTarget);
    draw();
  };
}

// ---------- faktura: detail ----------

async function viewInvoice(params, id) {
  let inv = await api('invoices/' + id);
  if (!inv.pdf_file && !inv.imported) {
    await storePdf(inv);
    inv = await api('invoices/' + id);
  }
  return () => {
    setTitle(`Faktura ${inv.number}`);
    const c = inv.customer;
    const url = inv.pdf_file ? pdfUrl(inv) : null;
    app.innerHTML = `
      <a class="back" href="#/faktury">‹ Faktury</a>
      <div class="page-head">
        <h1>Faktura ${esc(inv.number)} ${statusLabel(inv)}</h1>
        <div class="actions">
          ${inv.status === 'issued' ? '<button class="btn" data-act="paid">Označit jako zaplacenou…</button>' : ''}
          <a class="btn" href="#/faktura/${inv.id}/upravit">Upravit</a>
          <a class="btn" href="#/faktura/nova?z=${inv.id}">Duplikovat</a>
          ${url ? `<a class="btn primary" href="${url}" download="${esc(pdfFileName(inv))}">Stáhnout PDF</a>` : ''}
        </div>
      </div>
      <div class="detail">
        <div>
          <div class="card">
            <dl class="facts">
              <dt>Částka</dt><dd class="big">${Fmt.money(inv.total)}</dd>
              <dt>Odběratel</dt>
              <dd>${inv.contact_id ? `<a href="#/kontakt/${inv.contact_id}">${esc(c.name)}</a>` : esc(c.name)}
                <div class="muted">${[...addressLines(c), c.ico && `IČO ${c.ico}`].filter(Boolean).map(esc).join('<br>')}</div></dd>
              <dt>Vystaveno</dt><dd>${Fmt.date(inv.issue_date)}</dd>
              <dt>Splatnost</dt><dd>${Fmt.date(inv.due_date)}</dd>
              <dt>Variabilní symbol</dt><dd>${esc(inv.vs)}</dd>
              ${inv.status === 'paid' ? `<dt><label for="paid-date" style="font-weight:400">Zaplaceno dne</label></dt><dd><input type="date" id="paid-date" value="${esc(inv.paid_date)}"></dd>` : ''}
            </dl>
          </div>
          ${inv.imported ? '<p class="hint" style="margin:0 4px 12px">Převzatá faktura – zobrazuje se původní PDF.</p>' : ''}
          <div class="side-actions">
            ${url ? '<button class="btn ghost" data-act="reveal">Ukázat ve Finderu</button>' : ''}
            ${inv.status === 'paid' ? '<button class="btn ghost" data-act="unpaid">Vrátit mezi nezaplacené</button>' : ''}
            ${inv.status === 'cancelled'
              ? '<button class="btn ghost" data-act="restore">Zrušit storno</button>'
              : '<button class="btn ghost" data-act="cancel">Stornovat…</button>'}
            <button class="btn ghost danger" data-act="delete">Smazat…</button>
          </div>
        </div>
        ${url ? `<iframe class="pdf-frame" src="${url}" title="Náhled faktury ${esc(inv.number)}"></iframe>` : '<div class="card empty">PDF chybí.</div>'}
      </div>`;

    const setStatus = async (status, paidDate) => {
      const updated = await api(`invoices/${inv.id}/status`, { method: 'POST', body: { status, paid_date: paidDate } });
      // Stornovaná faktura má v PDF vodoznak, proto se při změně storna PDF přegeneruje.
      if (!updated.imported && (status === 'cancelled') !== (inv.status === 'cancelled')) await storePdf(updated);
      router(false);
    };
    const actions = {
      paid: null, // řeší markPaid níže (dialog nemá točit kolečko)
      unpaid: () => setStatus('issued'),
      cancel: async () => {
        if (!confirm(`Stornovat fakturu ${inv.number}?\n\nZůstane v evidenci i v číselné řadě, jen se označí jako stornovaná.`)) return;
        await setStatus('cancelled');
        toast('Faktura stornována');
      },
      restore: () => setStatus('issued'),
      reveal: () => api(`invoices/${inv.id}/reveal`, { method: 'POST', body: {} }),
      delete: async () => {
        if (!confirm(`Opravdu smazat fakturu ${inv.number}?\n\nMaž jen omylem vytvořenou fakturu – jinak vznikne v číselné řadě díra. Na zrušení platné faktury použij Stornovat.`)) return;
        await api('invoices/' + inv.id, { method: 'DELETE' });
        toast('Faktura smazána');
        location.hash = '#/faktury';
      },
    };
    $$('[data-act]').forEach(b => (b.onclick = () => (b.dataset.act === 'paid' ? markPaid([inv], b) : attempt(actions[b.dataset.act], b))));
    const paid = $('#paid-date');
    if (paid) paid.onchange = () => paid.value && attempt(async () => {
      await setStatus('paid', paid.value);
      toast('Datum úhrady uloženo');
    });
  };
}

// ---------- faktura: formulář ----------

async function viewInvoiceForm(params, id) {
  const [settings, contacts] = await Promise.all([api('settings'), api('contacts')]);
  contacts.sort(byName);
  let inv;
  if (id) {
    inv = await api('invoices/' + id);
  } else {
    const source = params.get('z') ? await api('invoices/' + params.get('z')) : null;
    const contact = contacts.find(c => c.id === (source ? source.contact_id : Number(params.get('kontakt'))));
    const { number } = await api('next-number');
    const issue = isoDate();
    inv = {
      number,
      status: 'issued',
      issue_date: issue,
      due_date: addDays(issue, Number(settings.due_days) || 14),
      contact_id: contact?.id ?? null,
      customer: contact ? pickCustomer(contact) : source?.customer ?? null,
      items: source ? source.items : [{ description: '', quantity: 1, unit: '', price: '' }],
      note: source?.note ?? '',
    };
  }
  return () => renderInvoiceForm(inv, id, settings, contacts);
}

function renderInvoiceForm(inv, id, settings, contacts) {
  setTitle(id ? `Upravit fakturu ${inv.number}` : 'Nová faktura');
  const state = {
    contactId: inv.contact_id,
    customer: inv.customer,
    isNew: false,
    items: inv.items.map(it => ({ ...it })),
  };
  let dirty = false;
  const markDirty = () => (dirty = true);
  leaveGuard = () => dirty;

  const backHref = id ? `#/faktura/${id}` : '#/faktury';
  const currentSupplier = Object.fromEntries(SUPPLIER_FIELDS.map(k => [k, settings[k] ?? '']));
  const supplierChanged = id && !inv.imported && !sameData(inv.supplier, currentSupplier, SUPPLIER_FIELDS);

  app.innerHTML = `
    <a class="back" href="${backHref}">‹ ${id ? 'Zpět na fakturu' : 'Faktury'}</a>
    <div class="page-head"><h1>${id ? `Upravit fakturu ${esc(inv.number)}` : 'Nová faktura'}</h1></div>
    ${missingSettings(settings) ? '<div class="notice">Chybí tvoje údaje nebo číslo účtu – doplň je v <a href="#/nastaveni">Nastavení</a>, jinak nebudou na faktuře.</div>' : ''}
    ${inv.imported ? '<div class="notice info">Převzatá faktura – změny se uloží do evidence, PDF zůstane původní.</div>' : ''}
    <form id="invoice-form" autocomplete="off" novalidate>
      <section class="card">
        <h2>Odběratel</h2>
        <div class="customer-pick">
          <input id="contact-search" list="contact-list" placeholder="Vyber z kontaktů – začni psát název nebo IČO…" aria-label="Vyhledat odběratele v kontaktech">
          <datalist id="contact-list">${contacts.map(c => `<option value="${esc(contactLabel(c))}"></option>`).join('')}</datalist>
          <button type="button" class="btn" id="new-customer">Nový odběratel</button>
        </div>
        <div id="customer-box"></div>
      </section>
      <section class="card">
        <div class="grid">
          ${field('Číslo faktury', 'name="number" required spellcheck="false"', inv.number, { cls: 'c2' })}
          ${field('Datum vystavení', 'name="issue_date" required', inv.issue_date, { cls: 'c2', type: 'date' })}
          ${field('Datum splatnosti', 'name="due_date" required', inv.due_date, { cls: 'c2', type: 'date' })}
        </div>
      </section>
      <section class="card">
        <h2>Položky</h2>
        <table class="items">
          <thead><tr><th>Popis</th><th class="w-qty">Množství</th><th class="w-unit">Jednotka</th><th class="w-price">Cena za jedn.</th><th class="w-amount num">Celkem</th><th class="w-del"><span class="sr-only">Odebrat</span></th></tr></thead>
          <tbody id="items"></tbody>
        </table>
        <datalist id="units">${UNITS.map(u => `<option value="${u}"></option>`).join('')}</datalist>
        <button type="button" class="btn ghost" id="add-item" style="margin-top:8px">+ Přidat položku</button>
        <div class="total-row"><span class="muted">Celkem k úhradě</span><strong id="total"></strong></div>
      </section>
      <section class="card">
        <label>Poznámka na faktuře (nepovinné)<textarea name="note" rows="2">${esc(inv.note)}</textarea></label>
        ${inv.status !== 'cancelled' ? `
          <div class="check-row" style="margin-top:14px">
            <label class="check"><input type="checkbox" name="is_paid" ${inv.status === 'paid' ? 'checked' : ''}> Už zaplaceno</label>
            <input type="date" name="paid_date" value="${esc(inv.paid_date || isoDate())}" aria-label="Datum úhrady" ${inv.status === 'paid' ? '' : 'hidden'}>
          </div>` : ''}
        ${supplierChanged ? '<label class="check" style="margin-top:6px"><input type="checkbox" name="refresh_supplier"> Tvoje údaje v Nastavení se od vystavení změnily – použít na této faktuře ty aktuální</label>' : ''}
      </section>
      <div class="form-actions">
        <a class="btn" href="${backHref}">Zrušit</a>
        <button type="submit" class="btn primary">${inv.imported ? 'Uložit' : id ? 'Uložit a přegenerovat PDF' : 'Vystavit fakturu'}</button>
      </div>
    </form>`;

  const form = $('#invoice-form');
  form.addEventListener('input', markDirty);

  // --- odběratel ---
  const box = $('#customer-box');
  const drawCustomer = () => {
    if (state.isNew) {
      const c = state.customer;
      box.innerHTML = `
        <div class="grid">
          ${field('Název / jméno', 'data-c="name"', c.name, { cls: 'c4' })}
          ${icoField('data-c="ico"', c.ico)}
          ${field('Ulice a číslo', 'data-c="street"', c.street)}
          ${field('PSČ', 'data-c="zip" inputmode="numeric"', c.zip, { cls: 'c1' })}
          ${field('Město', 'data-c="city"', c.city, { cls: 'c2' })}
          ${field('DIČ', 'data-c="dic" spellcheck="false"', c.dic, { cls: 'c2' })}
          ${field('E-mail', 'data-c="email" spellcheck="false"', c.email, { cls: 'c2', type: 'email' })}
          ${field('Stát (jen pokud není ČR)', 'data-c="country"', c.country, { cls: 'c2' })}
        </div>
        <p class="hint">Nový odběratel se zároveň uloží do kontaktů.</p>`;
      $$('[data-c]', box).forEach(el => (el.oninput = () => (state.customer[el.dataset.c] = el.value)));
      $('[data-ares]', box).onclick = e => attempt(async () => {
        Object.assign(state.customer, await loadAres(state.customer.ico));
        markDirty();
        drawCustomer();
      }, e.currentTarget);
    } else if (state.customer) {
      const c = state.customer;
      const contact = contacts.find(x => x.id === state.contactId);
      const stale = contact && !sameData(c, pickCustomer(contact), CUSTOMER_FIELDS);
      box.innerHTML = `
        <div class="customer-card">
          <div class="name">${esc(c.name)}</div>
          <div class="muted">${[...addressLines(c), c.ico && `IČO ${c.ico}`, c.dic && `DIČ ${c.dic}`].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
        ${stale ? '<p class="hint">Údaje v kontaktu se mezitím změnily. <a href="#" id="use-current">Použít aktuální</a></p>' : ''}`;
      const useCurrent = $('#use-current', box);
      if (useCurrent) useCurrent.onclick = e => {
        e.preventDefault();
        state.customer = pickCustomer(contact);
        markDirty();
        drawCustomer();
      };
    } else {
      box.innerHTML = '<p class="hint" style="margin:0">Vyber odběratele z kontaktů, nebo přidej nového.</p>';
    }
  };
  const search = $('#contact-search');
  search.addEventListener('input', () => {
    const c = contacts.find(x => contactLabel(x) === search.value);
    if (!c) return;
    Object.assign(state, { contactId: c.id, customer: pickCustomer(c), isNew: false });
    search.value = '';
    drawCustomer();
  });
  $('#new-customer').onclick = () => {
    Object.assign(state, { contactId: null, customer: pickCustomer({}), isNew: true });
    markDirty();
    drawCustomer();
    $('[data-c="name"]', box).focus();
  };

  // --- data a úhrada ---
  const els = form.elements;
  let lastIssue = els.issue_date.value;
  els.issue_date.addEventListener('change', () => {
    // splatnost se posune spolu s datem vystavení
    if (els.issue_date.value && lastIssue && els.due_date.value) {
      els.due_date.value = addDays(els.issue_date.value, daysBetween(lastIssue, els.due_date.value));
    }
    lastIssue = els.issue_date.value;
  });
  if (els.is_paid) els.is_paid.addEventListener('change', () => (els.paid_date.hidden = !els.is_paid.checked));

  // --- položky ---
  const tbody = $('#items');
  const updateTotals = () => {
    let total = 0;
    $$('tr[data-i]', tbody).forEach(tr => {
      const it = state.items[tr.dataset.i];
      const amount = round2(parseNum(it.quantity) * parseNum(it.price));
      total += amount;
      $('[data-amount]', tr).textContent = Fmt.money(amount, false);
    });
    $('#total').textContent = Fmt.money(round2(total));
  };
  const drawItems = () => {
    tbody.innerHTML = state.items.map((it, i) => `
      <tr data-i="${i}">
        <td><input data-k="description" value="${esc(it.description)}" placeholder="Popis položky…" aria-label="Popis položky ${i + 1}"></td>
        <td class="w-qty"><input data-k="quantity" class="num" inputmode="decimal" value="${esc(decimalInput(it.quantity))}" placeholder="1" aria-label="Množství"></td>
        <td class="w-unit"><input data-k="unit" list="units" value="${esc(it.unit)}" aria-label="Jednotka"></td>
        <td class="w-price"><input data-k="price" class="num" inputmode="decimal" value="${esc(decimalInput(it.price))}" placeholder="0" aria-label="Cena za jednotku"></td>
        <td class="w-amount num" data-amount></td>
        <td class="w-del">${state.items.length > 1 ? `<button type="button" class="del" data-del aria-label="Odebrat položku ${i + 1}">×</button>` : ''}</td>
      </tr>`).join('');
    updateTotals();
  };
  tbody.addEventListener('input', e => {
    const tr = e.target.closest('tr[data-i]');
    state.items[tr.dataset.i][e.target.dataset.k] = e.target.value;
    updateTotals();
  });
  tbody.addEventListener('click', e => {
    if (!e.target.matches('[data-del]')) return;
    state.items.splice(Number(e.target.closest('tr').dataset.i), 1);
    markDirty();
    drawItems();
  });
  $('#add-item').onclick = () => {
    state.items.push({ description: '', quantity: 1, unit: state.items.at(-1)?.unit || '', price: '' });
    drawItems();
    $('tr[data-i]:last-child [data-k="description"]', tbody).focus();
  };

  // Enter v políčku nemá fakturu omylem odeslat; Cmd/Ctrl+Enter ano.
  form.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.target.tagName === 'INPUT') {
      e.preventDefault();
    }
  });

  form.onsubmit = e => {
    e.preventDefault();
    attempt(async () => {
      if (!state.customer?.name?.trim()) {
        (state.isNew ? $('[data-c="name"]', box) : search).focus();
        throw new Error('Vyber nebo vyplň odběratele.');
      }
      const items = state.items.filter(it => String(it.description).trim() || String(it.price).trim());
      if (!items.length) {
        $('[data-k="description"]', tbody).focus();
        throw new Error('Přidej aspoň jednu položku.');
      }
      const body = {
        number: els.number.value,
        issue_date: els.issue_date.value,
        due_date: els.due_date.value,
        contact_id: state.contactId,
        customer: state.customer,
        save_contact: state.isNew,
        items: items.map(it => ({ ...it, quantity: parseNum(it.quantity), price: parseNum(it.price) })),
        note: els.note.value,
        refresh_supplier: Boolean(els.refresh_supplier?.checked),
      };
      if (els.is_paid) {
        body.status = els.is_paid.checked ? 'paid' : 'issued';
        body.paid_date = els.is_paid.checked ? els.paid_date.value : null;
      }
      const saved = await api(id ? `invoices/${id}` : 'invoices', { method: id ? 'PUT' : 'POST', body });
      if (!saved.imported) await storePdf(saved);
      leaveGuard = null;
      toast(id ? 'Faktura uložena' : `Faktura ${saved.number} vystavena`);
      location.hash = `#/faktura/${saved.id}`;
    }, e.submitter);
  };

  drawCustomer();
  drawItems();
}

// ---------- příjem bez faktury ----------

async function viewIncomeForm(params, id) {
  const [income, incomes, contacts] = await Promise.all([id ? api('incomes/' + id) : null, api('incomes'), api('contacts')]);
  const payers = [...new Set([...incomes.map(i => i.payer), ...contacts.map(c => c.name)])].sort((a, b) => a.localeCompare(b, 'cs'));
  return () => {
    const inc = income || { date: isoDate(), amount: '', payer: '', description: '', doc_file: null };
    setTitle(id ? `Příjem od ${inc.payer}` : 'Příjem bez faktury');
    let dirty = false;
    leaveGuard = () => dirty;
    const back = `#/prehled?rok=${inc.date.slice(0, 4)}`;
    const docUrl = inc.doc_file ? archivUrl(inc.doc_file, inc.updated_at) : null;
    app.innerHTML = `
      <a class="back" href="${back}">‹ Přehled</a>
      <div class="page-head"><h1>${id ? `Příjem od ${esc(inc.payer)}` : 'Příjem bez faktury'}</h1></div>
      <form id="income-form" class="card" autocomplete="off" novalidate>
        <p class="muted" style="margin:0 0 18px">Peníze, které ti přišly, aniž bys vystavil fakturu (vyúčtování, honorář…).
          Započítají se do limitu pro sociální pojištění i pro DPH podle data přijetí.</p>
        <div class="grid">
          ${field('Datum přijetí', 'name="date" required', inc.date, { cls: 'c2', type: 'date' })}
          ${field('Částka (Kč)', 'name="amount" required class="num" inputmode="decimal" placeholder="0"', decimalInput(inc.amount), { cls: 'c2' })}
          ${field('Od koho', 'name="payer" required list="payers"', inc.payer, { cls: 'c2' })}
          ${field('Popis (nepovinné)', 'name="description" placeholder="Např. pořádání akce"', inc.description, { cls: 'c6' })}
          <div class="c6">
            <label>Doklad (nepovinné)<input type="file" name="doc" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"></label>
            <span class="hint">${docUrl
              ? `Uložený doklad: <a href="${docUrl}" target="_blank" rel="noopener">${esc(inc.doc_file.split('/').pop())}</a>. Nový soubor ho nahradí.`
              : 'Vyúčtování, výpis z účtu apod. – PDF, PNG nebo JPG. Uloží se do archivu vedle faktur.'}</span>
          </div>
        </div>
        <datalist id="payers">${payers.map(p => `<option value="${esc(p)}"></option>`).join('')}</datalist>
        <div class="form-actions" style="margin-top:20px">
          ${id ? '<button type="button" class="btn ghost danger" id="delete" style="margin-right:auto">Smazat…</button>' : ''}
          <a class="btn" href="${back}">Zrušit</a>
          <button type="submit" class="btn primary">Uložit</button>
        </div>
      </form>
      ${docUrl ? `<iframe class="pdf-frame" src="${docUrl}" title="Doklad k příjmu"></iframe>` : ''}`;

    const form = $('#income-form');
    form.addEventListener('input', () => (dirty = true));
    form.onsubmit = e => {
      e.preventDefault();
      attempt(async () => {
        const els = form.elements;
        const file = els.doc.files[0];
        if (file && file.size > 25 * 1024 * 1024) throw new Error('Doklad je moc velký (nejvýš 25 MB).');
        const body = { date: els.date.value, amount: els.amount.value, payer: els.payer.value, description: els.description.value };
        const saved = await api(id ? `incomes/${id}` : 'incomes', { method: id ? 'PUT' : 'POST', body });
        leaveGuard = null;
        if (file) {
          try {
            await api(`incomes/${saved.id}/doc`, { method: 'PUT', body: file });
          } catch (err) {
            if (!id) location.hash = `#/prijem/${saved.id}`; // ať se příjem neuloží podruhé
            throw new Error(`Příjem je uložený, ale doklad se nenahrál: ${err.message}`);
          }
        }
        toast(id ? 'Příjem uložen' : 'Příjem přidán');
        location.hash = `#/prehled?rok=${saved.date.slice(0, 4)}`;
      }, e.submitter);
    };
    const del = $('#delete');
    if (del) del.onclick = () => attempt(async () => {
      if (!confirm(`Smazat příjem ${Fmt.money(inc.amount)} od ${inc.payer}?${inc.doc_file ? '\n\nDoklad se přesune do složky data/smazane.' : ''}`)) return;
      await api('incomes/' + id, { method: 'DELETE' });
      leaveGuard = null;
      toast('Příjem smazán');
      location.hash = back;
    }, del);
  };
}

// ---------- kontakty ----------

async function viewContacts(params) {
  const contacts = (await api('contacts')).sort(byName);
  return () => {
    setTitle('Kontakty');
    app.innerHTML = `
      <div class="page-head"><h1>Kontakty</h1><a class="btn primary" href="#/kontakt/novy">Nový kontakt</a></div>
      <div class="toolbar"><input id="search" type="search" placeholder="Hledat…" aria-label="Hledat název, IČO nebo město" autocomplete="off" spellcheck="false"></div>
      <div class="table-card" id="list"></div>`;
    const draw = q => {
      q = q.toLowerCase();
      const rows = contacts.filter(c => !q || [c.name, c.ico, c.city, c.email].some(v => (v || '').toLowerCase().includes(q)));
      $('#list').innerHTML = rows.length ? `
        <div class="table-scroll"><table class="list">
          <thead><tr><th>Název</th><th>IČO</th><th>Město</th><th class="num">Faktur</th><th class="num">Fakturováno</th></tr></thead>
          <tbody>${rows.map(c => `
            <tr data-href="#/kontakt/${c.id}">
              <td class="strong"><a href="#/kontakt/${c.id}" style="color:inherit">${esc(c.name)}</a></td><td>${esc(c.ico)}</td><td>${esc(c.city)}</td>
              <td class="num">${c.invoice_count}</td><td class="num">${Fmt.money(c.invoiced)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : `<div class="empty">${contacts.length ? 'Nic nenalezeno.' : 'Zatím žádné kontakty.'}</div>`;
    };
    $('#search').oninput = e => draw(e.target.value.trim());
    draw('');
  };
}

async function viewContactForm(params, id) {
  const [contact, invoices] = id ? await Promise.all([api('contacts/' + id), api('invoices')]) : [{}, []];
  const theirs = invoices.filter(i => i.contact_id === id);
  return () => {
    setTitle(id ? contact.name : 'Nový kontakt');
    let dirty = false;
    leaveGuard = () => dirty;
    app.innerHTML = `
      <a class="back" href="#/kontakty">‹ Kontakty</a>
      <div class="page-head">
        <h1>${id ? esc(contact.name) : 'Nový kontakt'}</h1>
        ${id ? `<a class="btn primary" href="#/faktura/nova?kontakt=${id}">Nová faktura</a>` : ''}
      </div>
      <form id="contact-form" class="card" autocomplete="off" novalidate>
        <div class="grid">
          ${field('Název / jméno', 'name="name" required', contact.name, { cls: 'c4' })}
          ${icoField('name="ico"', contact.ico)}
          ${field('Ulice a číslo', 'name="street"', contact.street)}
          ${field('PSČ', 'name="zip" inputmode="numeric"', contact.zip, { cls: 'c1' })}
          ${field('Město', 'name="city"', contact.city, { cls: 'c2' })}
          ${field('DIČ', 'name="dic" spellcheck="false"', contact.dic, { cls: 'c2' })}
          ${field('E-mail', 'name="email" spellcheck="false"', contact.email, { cls: 'c2', type: 'email' })}
          ${field('Stát (jen pokud není ČR)', 'name="country"', contact.country, { cls: 'c2' })}
          <label class="c6">Poznámka (jen pro tebe, na faktuře není)<textarea name="note" rows="2">${esc(contact.note)}</textarea></label>
        </div>
        <div class="form-actions" style="margin-top:20px">
          ${id ? '<button type="button" class="btn ghost danger" id="delete" style="margin-right:auto">Smazat kontakt…</button>' : ''}
          <button type="submit" class="btn primary">Uložit</button>
        </div>
      </form>
      ${id ? `<h2 style="margin-top:32px">Faktury</h2>
        ${theirs.length ? `<div class="table-card">${invoiceTable(theirs, { footer: `${plural(theirs.length, 'faktura', 'faktury', 'faktur')} · celkem ${Fmt.money(sum(theirs.filter(i => i.status !== 'cancelled')))}` })}</div>` : '<p class="muted">Zatím žádné.</p>'}` : ''}`;

    const form = $('#contact-form');
    form.addEventListener('input', () => (dirty = true));
    $('[data-ares]', form).onclick = e => attempt(async () => {
      const data = await loadAres(form.elements.ico.value);
      for (const [k, v] of Object.entries(data)) if (form.elements[k]) form.elements[k].value = v;
      dirty = true;
    }, e.currentTarget);
    form.onsubmit = e => {
      e.preventDefault();
      attempt(async () => {
        if (!form.elements.name.value.trim()) {
          form.elements.name.focus();
          throw new Error('Vyplň název nebo jméno kontaktu.');
        }
        const saved = await api(id ? `contacts/${id}` : 'contacts', { method: id ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(form)) });
        leaveGuard = null;
        toast('Kontakt uložen');
        location.hash = id ? '#/kontakty' : `#/kontakt/${saved.id}`;
      }, e.submitter);
    };
    const del = $('#delete');
    if (del) del.onclick = () => attempt(async () => {
      if (!confirm(`Smazat kontakt ${contact.name}?\n\nJeho faktury zůstanou zachované.`)) return;
      await api('contacts/' + id, { method: 'DELETE' });
      leaveGuard = null;
      toast('Kontakt smazán');
      location.hash = '#/kontakty';
    }, del);
  };
}

// ---------- nastavení ----------

async function viewSettings() {
  const [s, cloud] = await Promise.all([api('settings'), api('zaloha')]);
  return () => {
    setTitle('Nastavení');
    let dirty = false;
    leaveGuard = () => dirty;
    app.innerHTML = `
      <div class="page-head"><h1>Nastavení</h1></div>
      <form id="settings-form" autocomplete="off" novalidate>
        <section class="card">
          <h2>Tvoje údaje</h2>
          <div class="grid">
            ${field('Jméno / název', 'name="name"', s.name, { cls: 'c4' })}
            ${icoField('name="ico"', s.ico)}
            ${field('Ulice a číslo', 'name="street"', s.street)}
            ${field('PSČ', 'name="zip" inputmode="numeric"', s.zip, { cls: 'c1' })}
            ${field('Město', 'name="city"', s.city, { cls: 'c2' })}
            ${field('Informace o zápisu (povinný údaj na faktuře)', 'name="registration"', s.registration, { cls: 'c6' })}
          </div>
        </section>
        <section class="card">
          <h2>Platby</h2>
          <div class="grid">
            <label class="c3">Číslo účtu<input name="account" value="${esc(s.account)}" placeholder="123456789/0800" spellcheck="false"><span class="hint" id="iban-hint"></span></label>
            ${field('Výchozí splatnost (dní)', 'name="due_days" min="0" max="365" inputmode="numeric"', s.due_days, { cls: 'c2', type: 'number' })}
          </div>
        </section>
        <section class="card">
          <h2>Podnikání</h2>
          <div class="grid">
            <div class="c6">
              <label class="check"><input type="checkbox" name="side_activity" ${s.side_activity ? 'checked' : ''}> Vedlejší činnost (podnikám při studiu nebo zaměstnání)</label>
              <span class="hint">Přehled pak hlídá limit, do kterého se neplatí sociální pojištění. Když vedlejší činnost netrvá celý rok (dostuduješ, dovršíš 26 let), limit se poměrně krátí.</span>
            </div>
            <label class="c3">Výdajový paušál<select name="expense_rate">${EXPENSE_RATES.map(([v, t]) => `<option value="${v}" ${Number(s.expense_rate) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          </div>
        </section>
        <section class="card">
          <h2>Kontakt v patičce faktury</h2>
          <div class="grid">
            ${field('E-mail', 'name="email" spellcheck="false"', s.email, { cls: 'c2', type: 'email' })}
            ${field('Telefon', 'name="phone" inputmode="tel"', s.phone, { cls: 'c2', type: 'tel' })}
            ${field('Web', 'name="web" spellcheck="false"', s.web, { cls: 'c2' })}
          </div>
        </section>
        <section class="card">
          <h2>Texty na faktuře</h2>
          <div class="grid">
            ${field('Text pod částkou', 'name="vat_note"', s.vat_note)}
            ${field('Text na konci faktury (nepovinné)', 'name="footer_note"', s.footer_note)}
          </div>
        </section>
        <div class="form-actions">
          <button type="button" class="btn" id="preview">Ukázková faktura</button>
          <button type="submit" class="btn primary">Uložit nastavení</button>
        </div>
      </form>
      <div id="preview-box"></div>
      <section class="card" style="margin-top:32px">
        <h2>Data a zálohy</h2>
        <p style="margin-top:0">Všechno je ve složce <b>data</b> vedle aplikace: <b>faktury.json</b> (faktury, kontakty, nastavení) a <b>archiv</b> (PDF všech faktur).
        Před první změnou každého dne se uloží kopie do <b>data/zalohy</b> (posledních 30 dní).</p>
        ${cloudStatus(cloud)}
        <a class="btn" href="/api/export" download>Stáhnout zálohu dat</a>
      </section>`;

    const form = $('#settings-form');
    form.addEventListener('input', () => (dirty = true));
    const values = () => {
      const v = Object.fromEntries(new FormData(form));
      v.iban = czIban(v.account);
      v.side_activity = form.elements.side_activity.checked;
      return v;
    };
    const hint = $('#iban-hint');
    const checkAccount = () => {
      const acc = form.elements.account.value.trim();
      if (!acc) {
        hint.textContent = 'Bez čísla účtu nebude na faktuře QR platba.';
        hint.className = 'hint bad';
      } else if (!parseCzAccount(acc)) {
        hint.textContent = 'Zadej ve tvaru 123456789/0800 nebo 19-123456789/0800.';
        hint.className = 'hint bad';
      } else {
        const valid = czAccountValid(acc);
        hint.textContent = `IBAN ${Fmt.iban(czIban(acc))}` + (valid ? ' ✓' : ' – číslo účtu nevypadá platně, zkontroluj ho.');
        hint.className = valid ? 'hint ok' : 'hint bad';
      }
    };
    form.elements.account.addEventListener('input', checkAccount);
    checkAccount();

    $('[data-ares]', form).onclick = e => attempt(async () => {
      const data = await loadAres(form.elements.ico.value);
      for (const k of ['name', 'ico', 'street', 'city', 'zip']) form.elements[k].value = data[k];
      dirty = true;
    }, e.currentTarget);

    form.onsubmit = e => {
      e.preventDefault();
      attempt(async () => {
        const v = values();
        if (v.account && !parseCzAccount(v.account)) {
          form.elements.account.focus();
          throw new Error('Číslo účtu zadej ve tvaru 123456789/0800.');
        }
        await api('settings', { method: 'PUT', body: v });
        dirty = false;
        toast('Nastavení uloženo');
      }, e.submitter);
    };

    $('#preview').onclick = e => attempt(async () => {
      const today = isoDate();
      const blob = await invoicePdfBlob({
        number: `${today.slice(0, 4)}0001`, vs: `${today.slice(0, 4)}0001`, status: 'issued',
        issue_date: today, due_date: addDays(today, Number(form.elements.due_days.value) || 14),
        supplier: values(),
        customer: { name: 'Ukázková firma s.r.o.', ico: '12345678', dic: 'CZ12345678', street: 'Dlouhá 12', city: 'Praha 1', zip: '110 00' },
        items: [
          { description: 'Ukázková položka', quantity: 10, unit: 'hod', price: 800, amount: 8000 },
          { description: 'Další položka', quantity: 1, unit: 'ks', price: 2500, amount: 2500 },
        ],
        total: 10500,
        note: '',
      });
      $('#preview-box').innerHTML = `<iframe class="pdf-frame" style="margin-top:16px" title="Ukázková faktura" src="${URL.createObjectURL(blob)}"></iframe>`;
      $('#preview-box').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }, e.currentTarget);
  };
}

function cloudStatus(c) {
  if (!c.dir) return '<p class="hint bad">Záloha do iCloud Drive je vypnutá.</p>';
  if (c.error) return `<p class="hint bad">Záloha do iCloud Drive selhala: ${esc(c.error)}</p>`;
  if (!c.last) return '<p class="hint">Záloha do iCloud Drive právě probíhá…</p>';
  const day = c.last.slice(0, 10) === isoDate() ? 'dnes' : Fmt.date(c.last.slice(0, 10));
  return `<p class="hint ok" style="margin-bottom:16px">Po každé změně se data zkopírují do iCloud Drive → <b>Faktury záloha</b>. Naposledy ${day} v ${c.last.slice(11, 16)} ✓</p>`;
}

// ---------- směrování ----------

const routes = [
  [/^\/prehled$/, viewDashboard],
  [/^\/faktury$/, viewInvoices],
  [/^\/faktura\/nova$/, p => viewInvoiceForm(p, null)],
  [/^\/faktura\/(\d+)$/, (p, id) => viewInvoice(p, Number(id))],
  [/^\/faktura\/(\d+)\/upravit$/, (p, id) => viewInvoiceForm(p, Number(id))],
  [/^\/prijem\/novy$/, p => viewIncomeForm(p, null)],
  [/^\/prijem\/(\d+)$/, (p, id) => viewIncomeForm(p, Number(id))],
  [/^\/kontakty$/, viewContacts],
  [/^\/kontakt\/novy$/, p => viewContactForm(p, null)],
  [/^\/kontakt\/(\d+)$/, (p, id) => viewContactForm(p, Number(id))],
  [/^\/nastaveni$/, viewSettings],
];
let routeToken = 0;
let leaveGuard = null; // vrací true, když jsou na stránce neuložené změny
let currentHash = location.hash;

/** Změní adresu bez znovunačtení stránky (filtry). */
function setHash(hash) {
  history.replaceState(null, '', hash);
  currentHash = location.hash;
}

async function router(navigated = true) {
  const [path, query] = (location.hash.slice(1) || '/prehled').split('?');
  const route = routes.find(([re]) => re.test(path));
  if (!route) return location.replace('#/prehled');
  const section = path.split('/')[1];
  $$('[data-nav]').forEach(a => {
    const on = section.startsWith(a.dataset.nav);
    a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });

  const token = ++routeToken;
  try {
    const render = await route[1](new URLSearchParams(query || ''), ...path.match(route[0]).slice(1));
    if (token !== routeToken) return; // mezitím se přešlo jinam
    if (navigated) leaveGuard = null;
    const y = window.scrollY;
    render();
    if (navigated) {
      window.scrollTo(0, 0);
      app.classList.remove('enter');
      void app.offsetWidth; // restart animace
      app.classList.add('enter');
    } else {
      window.scrollTo(0, y);
    }
  } catch (e) {
    if (token === routeToken) app.innerHTML = `<div class="notice">${esc(e.message)}</div><p><a href="#/prehled">Zpět na přehled</a></p>`;
  }
}

window.addEventListener('hashchange', () => {
  if (leaveGuard?.() && !confirm('Máš neuložené změny. Opravdu odejít?')) {
    history.replaceState(null, '', currentHash);
    return;
  }
  leaveGuard = null;
  currentHash = location.hash;
  router();
});
window.addEventListener('beforeunload', e => {
  if (leaveGuard?.()) e.preventDefault();
});

// Kliknutí kamkoli na řádek tabulky otevře detail.
app.addEventListener('click', e => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a, button, input, label, select, .sel')) location.hash = row.dataset.href;
});

router();
