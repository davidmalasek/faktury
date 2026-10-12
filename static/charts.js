/* Grafy bez knihoven: sloupce po měsících, pruhy odběratelů, měřák. */
'use strict';

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const MONTHS_SHORT = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Hezké maximum osy a krok mezi čárami (0 / 2 tis. / 4 tis. …). */
function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { top: 1000, step: 250 };
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= raw);
  return { top: step * Math.ceil(max / step), step };
}

/** 2 500 → „2,5 tis.“, 1 200 000 → „1,2 mil.“ */
function compactKc(v) {
  const short = n => String(+n.toFixed(1)).replace('.', ',');
  if (v >= 1e6) return `${short(v / 1e6)} mil.`;
  if (v >= 1e3) return `${short(v / 1e3)} tis.`;
  return String(Math.round(v));
}

/**
 * Sloupcový graf za 12 měsíců.
 * months: [{ value, count, href }] × 12, year: '2026', current: index aktuálního měsíce nebo -1
 */
function columnChart(el, { months, year, current = -1 }) {
  const values = months.map(m => m.value);
  const peak = Math.max(...values);
  const { top, step } = niceScale(peak);
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const pct = v => (v / top) * 100;
  const peakIndex = values.indexOf(peak);
  const describe = (m, i) => `${capitalize(MONTHS[i])} ${year}: ${Fmt.money0(m.value)}, ${plural(m.count, 'faktura', 'faktury', 'faktur')}`;

  el.innerHTML = `
    <div class="colchart">
      <div class="plot">
        ${ticks.map(t => `<div class="gridline${t === 0 ? ' base' : ''}" style="bottom:${pct(t)}%"><span class="tick">${t === 0 ? '0' : compactKc(t)}</span></div>`).join('')}
        <div class="cols">
          ${months.map((m, i) => `
            <a class="col" href="${m.href}" data-i="${i}" aria-label="${esc(describe(m, i))}">
              <span class="bar${m.value ? '' : ' zero'}" style="--h:${pct(m.value)}%;--i:${i}"></span>
              ${i === peakIndex && peak > 0 ? `<span class="cap" style="--h:${pct(m.value)}%" aria-hidden="true">${compactKc(m.value)}</span>` : ''}
            </a>`).join('')}
        </div>
      </div>
      <div class="xs" aria-hidden="true">${MONTHS_SHORT.map((s, i) => `<span class="${i === current ? 'now' : ''}">${s}</span>`).join('')}</div>
      <div class="tooltip" aria-hidden="true"><div class="tv"></div><div class="tl"></div></div>
    </div>`;

  const chart = el.querySelector('.colchart');
  const plot = el.querySelector('.plot');
  const tip = el.querySelector('.tooltip');
  const show = col => {
    const i = Number(col.dataset.i);
    tip.querySelector('.tv').textContent = Fmt.money0(values[i]);
    tip.querySelector('.tl').textContent = `${capitalize(MONTHS[i])} · ${plural(months[i].count, 'faktura', 'faktury', 'faktur')}`;
    const c = chart.getBoundingClientRect(), p = plot.getBoundingClientRect(), k = col.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(k.left - c.left + k.width / 2, half), c.width - half);
    tip.style.left = `${x}px`;
    tip.style.top = `${p.top - c.top + p.height * (1 - values[i] / top) - 10}px`;
    tip.classList.add('show');
  };
  const hide = () => tip.classList.remove('show');
  el.querySelectorAll('.col').forEach(col => {
    col.addEventListener('pointerenter', () => show(col));
    col.addEventListener('focus', () => show(col));
    col.addEventListener('pointerleave', hide);
    col.addEventListener('blur', hide);
  });
}

/** Vodorovné pruhy: rows = [{ label, value, href }] */
function barList(el, rows) {
  const max = Math.max(...rows.map(r => r.value), 1);
  el.innerHTML = `<div class="bars">${rows.map((r, i) => `
    <a href="${r.href}">
      <span class="name">${esc(r.label)}</span>
      <span class="val">${Fmt.money0(r.value)}</span>
      <span class="track" aria-hidden="true"><span class="fill" style="--w:${(r.value / max) * 100}%;--i:${i}"></span></span>
    </a>`).join('')}</div>`;
}

// Varování u limitu: oranžová od 75 %, červená od 90 % nebo když limit přetáhnou čekající platby.
const LIMIT_WARN = 0.75;
const LIMIT_BAD = 0.9;
function limitLevel(value, limit, pending = 0) {
  const ratio = value / limit;
  return ratio >= LIMIT_BAD || value + pending > limit ? 'bad' : ratio >= LIMIT_WARN ? 'warn' : '';
}
const flag = level => ({ bad: '🔴', warn: '⚠️' })[level] ?? '✅';

/**
 * Měřák vůči limitu. pending = světlejší úsek navíc (např. nezaplacené faktury),
 * legend = vlastní levá strana legendy.
 */
function meter(value, limit, { pending = 0, label = 'Obrat', legend } = {}) {
  const ratio = value / limit;
  const cls = limitLevel(value, limit, pending);
  const w = r => Math.min(Math.max(r, 0), 1) * 100;
  const rest = w((value + pending) / limit) - w(ratio);
  const pct = String(+(ratio * 100).toFixed(1)).replace('.', ',');
  // čekající platby, které by limit přetáhly, jsou šrafované červeně
  const overflow = value <= limit && value + pending > limit;
  return `
    <div class="meter ${cls}" role="meter" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${Math.round(value)}"
         aria-label="${label} ${Fmt.money0(value)} z limitu ${Fmt.money0(limit)}${pending > 0 ? `, dalších ${Fmt.money0(pending)} čeká na platbu${overflow ? ' a limit by přetáhlo' : ''}` : ''}">
      <div style="--w:${w(ratio)}%"></div>${rest > 0 ? `<div class="pending${value > 0 ? ' gap' : ''}${overflow ? ' over' : ''}" style="--w:${rest}%"></div>` : ''}</div>
    <div class="meter-legend">${legend ?? `<span>${Fmt.money0(value)}</span>`}<span>${pct} % z ${Fmt.money0(limit)}</span></div>`;
}
