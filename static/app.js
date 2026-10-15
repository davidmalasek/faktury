'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const app = $('#app');

const UNITS = ['ks', 'hod', 'den', 'měs.', 'km', 'm²', 'paušál'];
const CUSTOMER_FIELDS = ['name', 'ico', 'dic', 'street', 'city', 'zip', 'country', 'email'];
const SUPPLIER_FIELDS = ['name', 'street', 'city', 'zip', 'ico', 'registration', 'account', 'iban', 'email', 'phone', 'web', 'vat_note', 'footer_note'];
// Obrat za kalendářní rok, nad který se neplátce musí registrovat k DPH (od 2025): nad 2 mil. Kč
// je plátcem od 1. 1. dalšího roku, nad 2 536 500 Kč (100 000 €) hned ode dne po překročení.
const VAT_LIMIT = 2000000;
const VAT_LIMIT_NOW = 2536500;
// Rozhodná částka pro vedlejší SVČ (ČSSZ): když zisk za rok dosáhne této částky, platí se sociální pojištění.
// Každý rok doplnit novou hodnotu (zveřejňuje se na podzim předchozího roku).
const SOCIAL_LIMITS = { 2025: 111736, 2026: 117521, 2027: 123992 };
// Daň z příjmů: 15 % ze zisku zaokrouhleného dolů na stovky, minus sleva na poplatníka.
// Sazba 23 % platí až nad 36násobkem průměrné mzdy (2026: 1 762 812 Kč), s tou se nepočítá.
// Od roku 2027 se má vrátit sleva na studenta (4 020 Kč) – až bude zákon platit, doplnit ji podle roku.
const TAX_RATE = 15;
const TAX_CREDIT = 30840;
const EXPENSE_CAPS = { 80: 1600000, 60: 1200000, 40: 800000 }; // strop paušálních výdajů za rok
// Zdravotní pojištění OSVČ: 13,5 % z poloviny zisku. Při vedlejší činnosti (student, zaměstnanec)
// se od roku 2026 zálohy neplatí a celé pojistné se doplácí po podání přehledu.
const HEALTH_RATE = 13.5;
// Sociální pojištění OSVČ: 29,2 % z 55 % zisku. U vedlejší činnosti jen když zisk dosáhne rozhodné částky.
// 55 % z rozhodné částky odpovídá minimálnímu vyměřovacímu základu, takže minimum se prakticky neuplatní.
const SOCIAL_RATE = 29.2;
const SOCIAL_BASE = 55;
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

let busy = 0; // rozpracované požadavky – mezitím se stránka sama neobnoví
let seenRev = null; // stav dat, který stránka ukazuje (viz živé obnovení)

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
  busy++;
  try {
    res = await fetch('/api/' + path, init);
  } catch {
    throw new Error('Server Faktur neběží – stiskni ⌘R, nebo Faktury zavři a spusť znovu.');
  } finally {
    busy--;
  }
  if (res.headers.get('X-Rev')) seenRev = res.headers.get('X-Rev'); // změnu udělala tahle stránka
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
// Příjem patří do roku, kdy peníze přišly: zaplacené faktury podle data zaplacení + příjmy bez faktury za rok.
const receivedIn = (year, active, incomes) => sum(active.filter(i => i.status === 'paid' && (i.paid_date || '').startsWith(year))) + sumAmount(incomes);
const ceilKc = n => Math.ceil(n - 1e-6); // daň a pojistné se zaokrouhlují na koruny nahoru
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
const offeredLabel = c => `${contactLabel(c)} — ${c.app_name}`; // kontakt z jiné aplikace (Hodinovka…)
// Skutečná ikona aplikace systému. Ikony všech aplikací jsou v static/mejvos (v každé aplikaci stejné).
const appIcon = (id, size = 16) => `<img class="app-icon" src="mejvos/${esc(encodeURIComponent(id))}.svg" alt="" width="${size}" height="${size}">`;
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

/** Smaže faktury (jednu z detailu nebo víc vybraných v seznamu). Vrátí true, když je smazal. */
async function deleteInvoices(list, button) {
  const one = list.length === 1;
  const paid = list.filter(i => i.status === 'paid').length;
  const apps = [...new Set(list.filter(i => i.source).map(i => i.source.name))];
  const lines = [
    `Maž jen omylem ${one ? 'vytvořenou fakturu' : 'vytvořené faktury'} – jinak vznikne v číselné řadě díra. Na zrušení platné faktury použij Stornovat.`,
    !paid ? '' : one ? 'Faktura je už zaplacená.' : paid === 1 ? 'Jedna z nich je už zaplacená.' : `Zaplacených je mezi nimi ${paid}.`,
    apps.length ? `V aplikaci ${apps.join(' a ')} se odpracovaný čas vrátí mezi nevyfakturovaný.` : '',
  ];
  if (!confirm(`Opravdu smazat ${one ? `fakturu ${list[0].number}` : plural(list.length, 'fakturu', 'faktury', 'faktur')}?\n\n${lines.filter(Boolean).join('\n\n')}`)) return false;
  return Boolean(await attempt(async () => {
    await api('invoices/delete', { method: 'POST', body: { ids: list.map(i => i.id) } });
    toast(one ? 'Faktura smazána' : plural(list.length, 'faktura smazána', 'faktury smazány', 'faktur smazáno'));
    return true;
  }, button));
}

function invoiceRows(rows, { selectable = false } = {}) {
  return rows.map(i => `
    <tr data-href="#/faktura/${i.id}" data-id="${i.id}">
      ${selectable ? `<td class="sel"><label><input type="checkbox" data-select="${i.id}" aria-label="Vybrat fakturu ${esc(i.number)}"></label></td>` : ''}
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
        ${opts.selectable ? '<th class="sel"><label><input type="checkbox" data-select-all aria-label="Vybrat všechny"></label></th>' : ''}
        <th>Číslo</th><th>Odběratel</th><th class="hide-sm">Vystaveno</th><th class="hide-sm">Splatnost</th><th class="num">Částka</th><th class="hide-sm">Stav</th>
      </tr></thead>
      <tbody>${invoiceRows(rows, opts)}</tbody>
      ${opts.footer ? `<tfoot><tr><td colspan="${opts.selectable ? 7 : 6}">${opts.footer}</td></tr></tfoot>` : ''}
    </table></div>`;
}

// ---------- přehled ----------

async function viewDashboard(params) {
  const [invoices, incomes, settings, taxReturn] = await Promise.all([api('invoices'), api('incomes'), api('settings'), api('priznani')]);
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

    const turnover = sum(inYear) + sumAmount(incomesInYear);
    const vatLevel = limitLevel(turnover, VAT_LIMIT);
    const alerts = isCurrent ? yearAlerts({ year, turnover, received: receivedIn(year, active, incomesInYear), pending: sum(unpaid), settings }) : [];
    if (isCurrent && taxReturn.show) alerts.unshift(taxReturnAlert(taxReturn, { active, incomes, settings }));

    app.innerHTML = `
      ${missingSettings(settings) ? '<div class="notice">Doplň svoje údaje a číslo účtu v <a href="#/nastaveni">Nastavení</a>.</div>' : ''}
      <div class="page-head">
        <h1>Přehled</h1>
        <nav class="segmented" aria-label="Rok">${years.map(y => `<a href="#/prehled?rok=${y}" class="${y === year ? 'on' : ''}" ${y === year ? 'aria-current="page"' : ''}>${y}</a>`).join('')}</nav>
      </div>
      ${alerts.length ? `<div class="alerts">${alertList(alerts)}</div>` : ''}
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
        ${duesCard({ year, isCurrent, active, unpaid, incomes: incomesInYear, settings })}
        <section class="card">
          <div class="card-head"><h2>Limit pro DPH</h2><span class="muted">${year}</span></div>
          ${meter(turnover, VAT_LIMIT)}
          <p class="limit-note ${vatLevel}">${flag(vatLevel)} ${turnover > VAT_LIMIT
            ? `Limit je překročený o ${Fmt.money0(turnover - VAT_LIMIT)}`
            : `Do limitu zbývá ${vatLevel ? 'už jen ' : ''}${Fmt.money0(VAT_LIMIT - turnover)}`}</p>
          <p class="hint">Když obrat za kalendářní rok přesáhne 2&nbsp;000&nbsp;000&nbsp;Kč, budeš od 1.&nbsp;1. dalšího roku plátce DPH, nad 2&nbsp;536&nbsp;500&nbsp;Kč hned ode dne po překročení.${incomesInYear.length ? ' Obrat zahrnuje i příjmy bez faktury.' : ''}</p>
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
    const filed = $('[data-filed]');
    if (filed) filed.onclick = () => attempt(async () => {
      await api('settings', { method: 'PUT', body: { tax_return_filed: taxReturn.year } });
      toast('Uloženo, připomínka se už neukáže');
      router(false);
    }, filed);
  };
}

// Nejvyšší příjmy, při kterých zisk (příjmy − paušál) zůstane pod rozhodnou částkou.
const socialMaxIncome = (limit, rate) => Math.floor((limit - 1) / (1 - rate / 100));
// Nejvyšší příjmy, při kterých sleva na poplatníka pokryje celou daň (zisk pod 205 700 Kč → základ 205 600 Kč).
const taxFreeIncome = rate => Math.ceil((Math.floor(TAX_CREDIT / TAX_RATE) * 100 + 100) * 100 / (100 - rate)) - 1;
const pctLabel = n => String(n).replace('.', ',') + ' %';

/** Varovné hlášky: [{ level: 'info' | 'warn' | 'bad', label, text, icon?, action? }] → seznam barevných upozornění. */
const alertList = alerts => alerts
  .sort((a, b) => (b.level === 'bad') - (a.level === 'bad'))
  .map(a => `<div class="notice ${a.level}"><span aria-hidden="true">${a.icon ?? flag(a.level)}</span><span><b>${a.label}:</b> ${a.text}</span>${a.action || ''}</div>`).join('');

/**
 * Varování na přehledu za letošek: obrat vůči limitu pro DPH (podle data vystavení), přijaté platby
 * vůči limitu pro sociální pojištění a vůči příjmům, které ještě pokryje sleva na dani.
 * pending = nezaplacené faktury, které můžou letos ještě přijít.
 */
function yearAlerts({ year, turnover, received, pending, settings }) {
  const alerts = [];
  const add = (level, label, text) => level && alerts.push({ level, label, text });
  const money = Fmt.money0;
  const rate = Number(settings.expense_rate) || 0;

  if (turnover > VAT_LIMIT_NOW) {
    add('bad', 'DPH', `obrat ${money(turnover)} je přes ${money(VAT_LIMIT_NOW)}, takže plátcem jsi už ode dne po překročení. Přihlášku k registraci je potřeba podat do 10 pracovních dnů.`);
  } else if (turnover > VAT_LIMIT) {
    add('bad', 'DPH', `obrat ${money(turnover)} je přes ${money(VAT_LIMIT)}, takže od 1. 1. ${Number(year) + 1} budeš plátce. Přihlášku k registraci je potřeba podat do 10 pracovních dnů. Nad ${money(VAT_LIMIT_NOW)} vzniká plátcovství hned.`);
  } else {
    add(limitLevel(turnover, VAT_LIMIT), 'DPH', `do limitu obratu ${money(VAT_LIMIT)} zbývá ${money(VAT_LIMIT - turnover)}.`);
  }

  const limit = settings.side_activity && SOCIAL_LIMITS[year];
  if (limit) {
    const max = socialMaxIncome(limit, rate);
    const left = max - received;
    const cliff = `Překročení by znamenalo sociální pojištění aspoň ${money(yearlyDues(max + 1, rate, limit).social)}.`;
    if (left < 0) {
      add('bad', 'Sociální pojištění', `limit je překročený o ${money(-left)}, za rok ${year} zatím vychází na ${money(yearlyDues(received, rate, limit).social)}.`);
    } else if (received + pending > max) {
      add('bad', 'Sociální pojištění', `čekající platby (${money(pending)}) by limit přetáhly, zbývá jen ${money(left)}. ${cliff} Platba přijatá až v lednu se počítá do dalšího roku.`);
    } else {
      const level = limitLevel(received, max);
      add(level, 'Sociální pojištění', `${level === 'bad' ? 'do limitu zbývá už jen' : 'blížíš se limitu, letos můžeš přijmout ještě'} ${money(left)}. ${cliff}`);
    }
  }

  // Daň roste plynule (žádný skok jako u pojištění), proto jen oranžově.
  const free = taxFreeIncome(rate);
  if (received <= free && limitLevel(received, free, pending)) {
    add('warn', 'Daň z příjmů', `od příjmů ${money(free + 1)} už sleva na poplatníka nepokryje celou daň, zbývá ${money(free - received)}.`);
  }
  return alerts;
}

/**
 * Varování k částce ve formuláři: když by faktura nebo příjem přetáhly limit pro DPH (obrat za rok
 * vystavení) nebo pro sociální pojištění (příjmy za rok zaplacení). invoices a incomes jsou ostatní
 * doklady, bez toho právě upravovaného.
 */
function amountAlerts({ amount, vatYear, paidYear, invoices, incomes, settings }) {
  const alerts = [];
  if (!(amount > 0) || !/^\d{4}$/.test(vatYear) || !/^\d{4}$/.test(paidYear)) return alerts;
  const add = (level, label, text) => level && alerts.push({ level, label, text });
  const money = Fmt.money0;
  const active = invoices.filter(i => i.status !== 'cancelled');
  const incomesIn = y => incomes.filter(i => i.date.startsWith(y));

  const before = sum(active.filter(i => i.issue_date.startsWith(vatYear))) + sumAmount(incomesIn(vatYear));
  const after = before + amount;
  if (before <= VAT_LIMIT_NOW && after > VAT_LIMIT_NOW) {
    add('bad', 'DPH', `obrat za rok ${vatYear} tím přesáhne ${money(VAT_LIMIT_NOW)}, takže plátcem DPH budeš hned ode dne po překročení.`);
  } else if (before <= VAT_LIMIT && after > VAT_LIMIT) {
    add('bad', 'DPH', `obrat za rok ${vatYear} tím přesáhne ${money(VAT_LIMIT)}, takže od 1. 1. ${Number(vatYear) + 1} budeš plátce DPH.`);
  } else if (after <= VAT_LIMIT) {
    add(limitLevel(after, VAT_LIMIT), 'DPH', `do limitu obratu za rok ${vatYear} pak zbude ${money(VAT_LIMIT - after)}.`);
  }

  const limit = settings.side_activity && SOCIAL_LIMITS[paidYear];
  if (limit) {
    const rate = Number(settings.expense_rate) || 0;
    const max = socialMaxIncome(limit, rate);
    const received = receivedIn(paidYear, active, incomesIn(paidYear)) + amount;
    const pending = paidYear === isoDate().slice(0, 4) ? sum(active.filter(i => i.status === 'issued')) : 0;
    if (received > max && received - amount <= max) {
      add('bad', 'Sociální pojištění', `příjmy za rok ${paidYear} tím přesáhnou limit o ${money(received - max)} a pojištění vyjde na ${money(yearlyDues(received, rate, limit).social)}. Platba přijatá až v roce ${Number(paidYear) + 1} se počítá do dalšího roku.`);
    } else if (received <= max && received + pending > max) {
      add('bad', 'Sociální pojištění', `spolu s čekajícími platbami (${money(pending)}) by příjmy za rok ${paidYear} limit přesáhly.`);
    } else if (received <= max) {
      add(limitLevel(received, max), 'Sociální pojištění', `do limitu za rok ${paidYear} pak zbude ${money(max - received)}.`);
    }
  }
  return alerts;
}

/** Daň a pojistné za rok z přijatých plateb (paušální výdaje, žádné jiné příjmy). limit = rozhodná částka. */
function yearlyDues(received, rate, limit) {
  const expenses = Math.min(received * rate / 100, EXPENSE_CAPS[rate] ?? Infinity);
  const profit = Math.max(0, round2(received - expenses));
  const base = Math.floor(profit / 100) * 100;
  const over = Boolean(limit) && received > socialMaxIncome(limit, rate);
  return {
    profit, base, over,
    tax: Math.max(0, ceilKc(base * TAX_RATE / 100) - TAX_CREDIT),
    health: ceilKc(profit / 2 * HEALTH_RATE / 100),
    social: over ? ceilKc(ceilKc(profit * SOCIAL_BASE / 100) * SOCIAL_RATE / 100) : 0,
  };
}

/**
 * Karta „Daň a pojištění“: kolik se za rok zaplatí v dalším roce. U vedlejší činnosti i zdravotní
 * a sociální pojištění s měřákem, kolik ještě můžu přijmout, aby zisk nedosáhl rozhodné částky.
 */
function duesCard({ year, isCurrent, active, unpaid, incomes, settings }) {
  const next = Number(year) + 1;
  const side = settings.side_activity;
  const rate = Number(settings.expense_rate) || 0;
  const limit = side ? SOCIAL_LIMITS[year] : 0;
  const received = receivedIn(year, active, incomes);
  const pending = isCurrent ? sum(unpaid) : 0;
  const total = d => d.tax + (side ? d.health + d.social : 0);
  const now = yearlyDues(received, rate, limit);
  const later = yearlyDues(received + pending, rate, limit);
  const crosses = later.over && !now.over;
  const freeIncome = taxFreeIncome(rate);
  // Daň nemá skok jako pojištění, takže se blížící hranice ukazuje nejvýš oranžově.
  const taxLevel = !now.tax && limitLevel(received, freeIncome, pending) ? 'warn' : '';

  // [popis, částka, poznámka, měřák, úroveň varování]
  const rows = [['Daň z příjmů', Fmt.money0(now.tax), now.tax
    ? `${pctLabel(TAX_RATE)} ze základu ${Fmt.money0(now.base)} minus sleva na poplatníka ${Fmt.money0(TAX_CREDIT)}`
    : `${flag(taxLevel)} sleva na poplatníka ji pokryje do ${rate ? 'příjmů' : 'zisku'} ${Fmt.money0(freeIncome)}`, '', taxLevel]];
  let socialHint = '';
  if (side) {
    rows.push(['Zdravotní pojištění', Fmt.money0(now.health), `${pctLabel(HEALTH_RATE)} z poloviny zisku`]);
    if (!limit) {
      rows.push(['Sociální pojištění', '–', `Rozhodnou částku pro rok ${year} appka zatím nezná.`]);
    } else {
      const maxIncome = socialMaxIncome(limit, rate);
      const left = maxIncome - received;
      const level = now.over ? 'over' : limitLevel(received, maxIncome, pending);
      const legend = `<span class="keys"><span><i class="sw"></i>Přijato ${Fmt.money0(received)}</span>${pending > 0 && !now.over ? `<span><i class="sw pending${crosses ? ' over' : ''}"></i>Čeká ${Fmt.money0(pending)}</span>` : ''}</span>`;
      rows.push(['Sociální pojištění', Fmt.money0(now.social),
        now.over ? `${flag('bad')} limit překročený o ${Fmt.money0(-left)} · ${pctLabel(SOCIAL_RATE)} z ${SOCIAL_BASE} % zisku`
          : isCurrent ? `${flag(level)} letos ještě můžeš přijmout ${level ? 'jen ' : ''}${Fmt.money0(left)} a platit ho nebudeš`
            : `${flag(level)} pod limitem o ${Fmt.money0(left)}`,
        meter(received, maxIncome, { pending, label: 'Přijato', legend }), level]);
      socialHint = now.over
        ? 'Po překročení limitu se od podání přehledu ČSSZ platí i měsíční zálohy na sociální pojištění.'
        : `Sociální pojištění se platí, až když zisk za rok dosáhne ${Fmt.money0(limit)} (rozhodná částka ${year})${rate ? `, při paušálu ${rate} % to je víc než ${Fmt.money0(maxIncome)} přijatých plateb` : ''}.`;
    }
  }

  return `
    <section class="card">
      <div class="card-head"><h2>${side ? 'Daň a pojištění' : 'Daň z příjmů'}</h2><span class="muted">za rok ${year} · platí se v roce ${next}</span></div>
      <div class="kpi-inline">
        <div class="k">${isCurrent ? `V roce ${next} zaplatíš` : `Za rok ${year} celkem`}</div>
        <div class="v">${Fmt.money0(total(now))}</div>
        <div class="d">${isCurrent ? 'podle dosud přijatých plateb, ' : ''}ze zisku ${Fmt.money0(now.profit)}</div>
      </div>
      <dl class="dues-list">${rows.map(([label, value, note, extra, level]) => `
        <div class="${level || ''}"><dt>${label}<span>${note}</span></dt><dd>${value}</dd>${extra ? `<dd class="extra">${extra}</dd>` : ''}</div>`).join('')}
      </dl>
      ${total(later) > total(now) ? `<p class="hint${crosses ? ' bad' : ''}">${crosses ? `${flag('bad')} ` : ''}Když ti letos přijdou i čekající platby (${Fmt.money0(pending)}), bude to ${Fmt.money0(total(later))}${crosses ? ', protože překročíš limit pro sociální pojištění' : ''}.</p>` : ''}
      <p class="hint">${socialHint}
        Daň se platí v termínu daňového přiznání${side ? ', pojistné do 8 dnů po podání přehledu' : ''}.
        ${side && Number(year) >= 2026 ? 'Zálohy na zdravotní se při studiu nebo zaměstnání od roku 2026 neplatí.' : ''}</p>
      <p class="hint">Počítají se platby podle data zaplacení${incomes.length ? ` včetně příjmů bez faktury (${Fmt.money0(sumAmount(incomes))})` : ''} a jen příjmy z podnikání, jiné příjmy (třeba brigáda) daň změní.
        ${rate ? `Paušál ${rate} % změníš` : 'Počítá se bez výdajů, takže skutečné částky budou nižší. Paušál nastavíš'} v&nbsp;<a href="#/nastaveni">Nastavení</a>.</p>
    </section>`;
}

// ---------- daňové přiznání ----------

const TAX_RETURN_MIN = 50000; // do těchto příjmů za rok (a bez jiných příjmů) se přiznání nepodává

/**
 * Připomínka přiznání za minulý rok (viz dane.py): od 1. 1., dokud ji neodklikneš.
 * Šedě, měsíc před termínem oranžově, týden před ním a po něm červeně.
 */
function taxReturnAlert(t, { active, incomes, settings }) {
  const year = String(t.year);
  const received = receivedIn(year, active, incomes.filter(i => i.date.startsWith(year)));
  const rate = Number(settings.expense_rate) || 0;
  const { tax } = yearlyDues(received, rate, settings.side_activity ? SOCIAL_LIMITS[year] : 0);
  const days = daysBetween(isoDate(), t.due);
  const when = days > 1 ? `za ${plural(days, 'den', 'dny', 'dní')}` : days === 1 ? 'zítra' : days === 0 ? 'dnes je poslední den'
    : `už ${plural(-days, 'den', 'dny', 'dní')} po termínu`;
  const level = days <= 7 ? 'bad' : days <= 30 ? 'warn' : 'info';
  return {
    level, icon: level === 'info' ? '📅' : undefined, label: `Daňové přiznání za rok ${year}`,
    text: `podej ho elektronicky do ${Fmt.date(t.due)} (${when}). Daň podle Faktur vychází na ${Fmt.money0(tax)}${tax ? ', zaplať ji do stejného dne' : ''}.`
      + (received <= TAX_RETURN_MIN ? ` Při příjmech do ${Fmt.money0(TAX_RETURN_MIN)} za rok (a bez jiných příjmů) ho podávat nemusíš.` : ''),
    action: '<button type="button" class="btn" data-filed>Hotovo</button>',
  };
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
    const chosen = () => invoices.filter(i => selected.has(i.id));

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
        <button type="button" class="btn ghost danger" id="bulk-delete">Smazat…</button>
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
      const unpaid = chosen().filter(i => i.status === 'issued').length;
      $('#bulk-paid').hidden = !unpaid;
      $('#bulk-paid').textContent = unpaid === selected.size ? 'Označit jako zaplacené…' : `Označit ${unpaid} jako zaplacené…`;
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
      for (const id of [...selected]) if (!rows.some(r => r.id === id)) selected.delete(id);
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
    $('#bulk-paid').onclick = e => markPaid(chosen().filter(i => i.status === 'issued'), e.currentTarget);
    $('#bulk-delete').onclick = e => deleteInvoices(chosen(), e.currentTarget).then(done => done && router(false));
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
              ${inv.source ? `<dt>Vytvořeno v aplikaci</dt><dd><span class="linked">${appIcon(inv.source.app)}${inv.source.link ? `<a href="${esc(inv.source.link)}">${esc(inv.source.name)}</a>` : esc(inv.source.name)}</span></dd>` : ''}
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
      delete: null, // řeší deleteInvoices níže (kolečko až po potvrzení)
    };
    $$('[data-act]').forEach(b => (b.onclick = async () => {
      if (b.dataset.act === 'paid') return markPaid([inv], b);
      if (b.dataset.act !== 'delete') return attempt(actions[b.dataset.act], b);
      if (await deleteInvoices([inv], b)) location.hash = '#/faktury';
    }));
    const paid = $('#paid-date');
    if (paid) paid.onchange = () => paid.value && attempt(async () => {
      await setStatus('paid', paid.value);
      toast('Datum úhrady uloženo');
    });
  };
}

// ---------- faktura: formulář ----------

async function viewInvoiceForm(params, id) {
  const [settings, contacts, invoices, incomes, offered] = await Promise.all([
    api('settings'), api('contacts'), api('invoices'), api('incomes'), api('offered').catch(() => [])]);
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
  return () => renderInvoiceForm(inv, id, settings, contacts, { invoices: invoices.filter(i => i.id !== inv.id), incomes }, offered);
}

/** others = ostatní faktury a příjmy pro varování u limitů, offered = kontakty z ostatních aplikací */
function renderInvoiceForm(inv, id, settings, contacts, others, offered = []) {
  setTitle(id ? `Upravit fakturu ${inv.number}` : 'Nová faktura');
  const state = {
    contactId: inv.contact_id,
    customer: inv.customer,
    isNew: false,
    peer: null, // kontakt převzatý z jiné aplikace (třeba klient z Hodinovky)
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
          <datalist id="contact-list">${contacts.map(c => `<option value="${esc(contactLabel(c))}"></option>`).join('')}${offered.map(c => `<option value="${esc(offeredLabel(c))}"></option>`).join('')}</datalist>
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
        <div class="alerts" id="limit-alerts"></div>
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
        <p class="hint">${state.peer ? `Klient z aplikace ${esc(state.peer.app_name)} – doplň, co chybí (třeba IČO z ARES). Uloží se do kontaktů.` : 'Nový odběratel se zároveň uloží do kontaktů.'}</p>`;
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
    const peer = !c && offered.find(x => offeredLabel(x) === search.value);
    if (peer) {
      Object.assign(state, { contactId: null, customer: pickCustomer(peer), isNew: true, peer });
      search.value = '';
      markDirty();
      return drawCustomer();
    }
    if (!c) return;
    Object.assign(state, { contactId: c.id, customer: pickCustomer(c), isNew: false, peer: null });
    search.value = '';
    drawCustomer();
  });
  $('#new-customer').onclick = () => {
    Object.assign(state, { contactId: null, customer: pickCustomer({}), isNew: true, peer: null });
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

  // Varování u limitů: DPH podle roku vystavení, sociální pojištění podle roku zaplacení (jinak splatnosti).
  const updateLimits = amount => {
    if (inv.status === 'cancelled') return;
    const paidDate = els.is_paid?.checked ? els.paid_date.value : els.due_date.value;
    $('#limit-alerts').innerHTML = alertList(amountAlerts({
      amount, vatYear: els.issue_date.value.slice(0, 4), paidYear: paidDate.slice(0, 4), ...others, settings,
    }));
  };
  form.addEventListener('change', () => updateTotals());

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
    updateLimits(round2(total));
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
        contact_uid: state.peer?.uid || null,
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
  const [income, incomes, contacts, invoices, settings] = await Promise.all([id ? api('incomes/' + id) : null, api('incomes'), api('contacts'), api('invoices'), api('settings')]);
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
          <div class="c6 alerts" id="limit-alerts"></div>
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
    const otherIncomes = incomes.filter(i => i.id !== inc.id);
    const updateLimits = () => {
      const year = form.elements.date.value.slice(0, 4);
      $('#limit-alerts').innerHTML = alertList(amountAlerts({
        amount: parseNum(form.elements.amount.value), vatYear: year, paidYear: year, invoices, incomes: otherIncomes, settings,
      }));
    };
    form.addEventListener('input', updateLimits);
    updateLimits();
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
  const [contacts, offered] = await Promise.all([api('contacts'), api('offered').catch(() => [])]);
  contacts.sort(byName);
  return () => {
    setTitle('Kontakty');
    app.innerHTML = `
      <div class="page-head"><h1>Kontakty</h1><a class="btn primary" href="#/kontakt/novy">Nový kontakt</a></div>
      <div class="toolbar"><input id="search" type="search" placeholder="Hledat…" aria-label="Hledat název, IČO nebo město" autocomplete="off" spellcheck="false"></div>
      <div class="table-card" id="list"></div>
      ${offered.length ? `
        <section class="table-card" style="margin-top:24px">
          <div class="card-head"><h2>Klienti z ostatních aplikací</h2><span class="muted">nabízí se i u nové faktury</span></div>
          <div class="table-scroll"><table class="list">
            <tbody>${offered.slice().sort(byName).map(c => `
              <tr data-href="#/kontakt/novy?z=${encodeURIComponent(c.uid)}">
                <td class="strong">${esc(c.name)}<div class="muted" style="font-weight:400;font-size:13px">${esc([c.ico && `IČO ${c.ico}`, c.city].filter(Boolean).join(' · ') || 'zatím bez IČO a adresy')}</div></td>
                <td class="hide-sm"><span class="linked">${appIcon(c.app)}${esc(c.app_name)}</span></td>
                <td class="num"><a class="btn" href="#/kontakt/novy?z=${encodeURIComponent(c.uid)}">Přidat do kontaktů</a></td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </section>` : ''}`;
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
  if (!id && params.get('z')) {  // klient z jiné aplikace: předvyplní se a zůstane s ní propojený (stejné uid)
    const peer = (await api('offered').catch(() => [])).find(c => c.uid === params.get('z'));
    if (peer) Object.assign(contact, pickCustomer(peer), { uid: peer.uid, app_name: peer.app_name });
  }
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
        ${!id && contact.uid ? `<input type="hidden" name="uid" value="${esc(contact.uid)}"><p class="hint">Klient z aplikace ${esc(contact.app_name)}.</p>` : ''}
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
  const [s, cloud, peers] = await Promise.all([api('settings'), api('zaloha'), api('peers').catch(() => null)]);
  const taxYear = new Date().getFullYear() - 1; // přiznání se podává za minulý rok
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
            <div class="c6">
              <label class="check"><input type="checkbox" name="tax_return_filed" ${Number(s.tax_return_filed) === taxYear ? 'checked' : ''}> Daňové přiznání za rok ${taxYear} mám podané</label>
              <span class="hint">Od ledna Přehled připomíná, do kdy přiznání za minulý rok podat. Když je podané, připomínka zmizí.</span>
            </div>
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
        <p style="margin-top:0">Faktury, kontakty i PDF máš jen u sebe na Macu ve složce <b>${esc(cloud.data)}</b>.
        Každý den se zálohují do její podsložky <b>zalohy</b> (posledních 30 dní).</p>
        ${cloudStatus(cloud)}
        <a class="btn" href="/api/export" download>Stáhnout zálohu dat</a>
      </section>
      ${peers ? peersCard(peers) : ''}
      <section class="card">
        <h2>Aktualizace</h2>
        <p class="hint" id="version-info" style="margin:0">Zjišťuji verzi…</p>
      </section>`;
    showVersion();
    $$('[data-open]').forEach(b => (b.onclick = () => attempt(async () => {
      await api(`peers/${b.dataset.open}/open`, { method: 'POST', body: {} });
      toast('Otevírám… po prvním spuštění se aplikace propojí sama');
    }, b)));
    $$('[data-install]').forEach(b => (b.onclick = () => attempt(async () => {
      toast('Stahuji a instaluji… může to minutu trvat');
      await api(`peers/${b.dataset.install}/install`, { method: 'POST', body: {} });
      toast('Nainstalováno a propojeno');
      router(false);
    }, b)));

    const form = $('#settings-form');
    form.addEventListener('input', () => (dirty = true));
    const values = () => {
      const v = Object.fromEntries(new FormData(form));
      v.iban = czIban(v.account);
      v.side_activity = form.elements.side_activity.checked;
      v.tax_return_filed = form.elements.tax_return_filed.checked ? taxYear : 0;
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

/** Ostatní aplikace systému (MejvOS): propojené, nainstalované, nebo ke stažení jedním kliknutím. */
function peersCard(peers) {
  return `
    <section class="card">
      <h2>Propojené aplikace</h2>
      <p style="margin-top:0">Faktury spolupracují s dalšími aplikacemi na tvém Macu, stačí je mít nainstalované. Třeba z Hodinovky vyfakturuješ odpracovaný čas jedním kliknutím.</p>
      <div class="apps">${peers.apps.map(a => `
        <div class="app-row">
          ${appIcon(a.id, 36)}
          <span class="who"><b>${esc(a.name)}</b><span>${esc(a.description)}</span></span>
          ${a.state === 'running' || a.state === 'ready'
            ? `<span class="state ok">✓ Propojeno${a.version ? ` · verze ${esc(a.version)}` : ''}</span><a class="btn" href="${esc(a.scheme || a.id)}://">Otevřít</a>`
            : a.state === 'installed'
              ? `<span class="state muted">Propojí se po prvním otevření</span><button type="button" class="btn" data-open="${esc(a.id)}">Otevřít</button>`
              : `<a class="btn ghost" href="${esc(a.web)}" target="_blank" rel="noopener">Co to je</a><button type="button" class="btn primary" data-install="${esc(a.id)}">Nainstalovat</button>`}
        </div>`).join('')}
      </div>
    </section>`;
}

function cloudStatus(c) {
  if (!c.dir) return '<p class="hint bad">Záloha do iCloud Drive je vypnutá.</p>';
  if (c.error) return `<p class="hint bad">Záloha do iCloud Drive selhala: ${esc(c.error)}</p>`;
  if (!c.last) return '<p class="hint">Záloha do iCloud Drive právě probíhá…</p>';
  const day = c.last.slice(0, 10) === isoDate() ? 'dnes' : Fmt.date(c.last.slice(0, 10));
  return `<p class="hint ok" style="margin-bottom:16px">Po každé změně se data zkopírují do iCloud Drive → <b>Faktury záloha</b>. Naposledy ${day} v ${c.last.slice(11, 16)} ✓</p>`;
}

// ---------- aktualizace ----------

/** Lišta nad obsahem, která zůstává i při přechodu mezi stránkami. */
function updateBar(html, action = '') {
  const bar = $('#update');
  bar.innerHTML = html ? `<div class="notice info"><span>${html}</span>${action}</div>` : '';
  bar.hidden = !html;
  const button = $('[data-update]', bar);
  if (button) button.onclick = () => installUpdate();
}

/** Při otevření appky zjistí, jestli na GitHubu nevyšla nová verze, a rovnou ji nainstaluje. */
async function checkForUpdate() {
  const u = await api('update').catch(() => null);
  if (!u?.available || u.git) return; // vývojová kopie z gitu se neaktualizuje
  if (leaveGuard?.()) {
    updateBar(`Vyšla nová verze Faktur ${esc(u.latest)}.`, '<button class="btn primary" data-update>Aktualizovat</button>');
  } else {
    installUpdate();
  }
}

async function installUpdate() {
  if (leaveGuard?.() && !confirm('Máš neuložené změny. Aktualizace stránku znovu načte – opravdu pokračovat?')) return;
  updateBar('Aktualizuji Faktury na novou verzi…');
  try {
    const result = await api('update', { method: 'POST', body: {} });
    // Server se restartuje s novým kódem – počkej, až naběhne.
    for (let i = 0; i < 60; i++) {
      await new Promise(done => setTimeout(done, 500));
      const v = await api('version').catch(() => null);
      if (v?.version !== result.version) continue;
      try { sessionStorage.setItem('updated', JSON.stringify(result)); } catch {}
      if (leaveGuard?.()) return updateBar(`Faktury jsou aktualizované na verzi ${esc(result.version)}. Po uložení změn načti stránku znovu (⌘R).`);
      return location.reload();
    }
    throw new Error('Server se po aktualizaci nespustil. Zavři Faktury a otevři je znovu.');
  } catch (e) {
    updateBar(`Aktualizace se nepovedla: ${esc(e.message)}`);
  }
}

/** Po aktualizaci a znovunačtení stránky řekne, co se stalo. */
function announceUpdate() {
  let result = null;
  try {
    result = JSON.parse(sessionStorage.getItem('updated'));
    sessionStorage.removeItem('updated');
  } catch {}
  if (!result) return;
  const done = `Faktury jsou aktualizované na verzi ${esc(result.version)}.`;
  if (result.app_error) updateBar(`${done} ${esc(result.app_error)}`);
  else if (result.app_changed) updateBar(`${done} Zavři Faktury a otevři je znovu, ať se načte i nové okno aplikace.`);
  else toast(done);
}

async function showVersion() {
  const u = await api('update').catch(() => null);
  const el = $('#version-info');
  if (!u || !el) return;
  let html = `Máš verzi <b>${esc(u.version)}</b>. `;
  if (!u.latest) html += 'Nové verze se hledají na GitHubu při každém otevření Faktur.';
  else if (!u.available) html += 'Je to nejnovější verze ✓';
  else if (u.git) html += `Vyšla verze ${esc(u.latest)}. Tohle je vývojová kopie z gitu, takže se aktualizace neinstalují.`;
  else html += `Vyšla verze ${esc(u.latest)}. <button class="btn primary" data-update>Aktualizovat</button>`;
  if (u.url) html += ` <a href="${esc(u.url)}" target="_blank" rel="noopener">Co je nového</a>`;
  el.innerHTML = html;
  const button = $('[data-update]', el);
  if (button) button.onclick = () => installUpdate();
}

// ---------- živé obnovení ----------

/* Když se data změní jinde (v Hodinovce, v druhém okně nebo v prohlížeči), otevřená stránka se sama obnoví.
   Neruší: počká, dokud uživatel něco píše, má otevřený dialog, vybrané řádky nebo neuložené změny. */
function canRefresh() {
  const el = document.activeElement;
  // rozepsaný text (kromě hledání, to se po obnovení vrátí) by obnovení smazalo
  const typed = $$('input, textarea', app).some(i => !['search', 'checkbox', 'radio', 'file'].includes(i.type) && i.value !== i.defaultValue);
  return !busy && !leaveGuard?.() && !typed && !$('dialog[open]') && !$('.bulkbar:not([hidden])') &&
    !(el && app.contains(el) && el.matches('input, textarea, select')) && !String(window.getSelection?.() || '');
}

async function refreshView() {
  const q = $('#search')?.value;
  await router(false);
  const search = $('#search');
  if (q && search && !search.value) {
    search.value = q;
    search.dispatchEvent(new Event('input'));
  }
}

async function watchChanges() {
  if (document.hidden) return;
  const r = await fetch('/api/rev').then(res => res.json()).catch(() => null);
  if (!r?.rev || r.rev === seenRev) return;
  if (seenRev !== null && !canRefresh()) return; // zkusí to znovu za chvíli
  const changed = seenRev !== null;
  seenRev = r.rev;
  if (changed) refreshView();
}

setInterval(watchChanges, 2000);
window.addEventListener('focus', watchChanges);
document.addEventListener('visibilitychange', watchChanges);

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

watchChanges();
router();
announceUpdate();
checkForUpdate();
