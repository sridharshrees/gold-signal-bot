// Trading rules, copied from the Gold Signal Desk app (index.html, ENGINE-START to ENGINE-END).
// Keep in step with the app: both must use the same rules.
// ENGINE-START  (pure functions, no DOM)
const RR = 1.5, ATR_MULT = 1.5, MAXHOLD = 32, WARM = 100, M15 = 900000, H1 = 3600000;

function ema(v, n){ const k = 2/(n+1), o = new Array(v.length); let e = v[0];
  for (let i = 0; i < v.length; i++){ e = i ? v[i]*k + e*(1-k) : v[0]; o[i] = e; } return o; }

function sma(v, n){ const o = new Array(v.length); let s = 0;
  for (let i = 0; i < v.length; i++){ s += v[i]; if (i >= n) s -= v[i-n]; o[i] = s/Math.min(i+1, n); } return o; }

function rsi(c, n = 14){ const o = new Array(c.length).fill(50); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++){ const d = c[i]-c[i-1], up = Math.max(d,0), dn = Math.max(-d,0);
    if (i <= n){ g += up/n; l += dn/n; } else { g = (g*(n-1)+up)/n; l = (l*(n-1)+dn)/n; }
    if (i >= n) o[i] = l === 0 ? 100 : 100 - 100/(1+g/l); } return o; }

function atr(b, n = 14){ const o = new Array(b.length).fill(0); let a = 0;
  for (let i = 0; i < b.length; i++){ const pc = i ? b[i-1].c : b[i].c;
    const tr = Math.max(b[i].h-b[i].l, Math.abs(b[i].h-pc), Math.abs(b[i].l-pc));
    a = i < n ? (a*i+tr)/(i+1) : (a*(n-1)+tr)/n; o[i] = a; } return o; }

function adx(b, n = 14){ const o = new Array(b.length).fill(0); let tr = 0, p = 0, m = 0, ax = 0;
  for (let i = 1; i < b.length; i++){ const up = b[i].h-b[i-1].h, dn = b[i-1].l-b[i].l;
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(b[i].h-b[i].l, Math.abs(b[i].h-b[i-1].c), Math.abs(b[i].l-b[i-1].c));
    tr = tr - tr/n + t; p = p - p/n + pdm; m = m - m/n + mdm;
    const pdi = tr ? 100*p/tr : 0, mdi = tr ? 100*m/tr : 0, s = pdi+mdi;
    const dx = s ? 100*Math.abs(pdi-mdi)/s : 0; ax = i <= n ? (ax*(i-1)+dx)/i : (ax*(n-1)+dx)/n; o[i] = ax; } return o; }

function macdHist(c){ const a = ema(c,12), b = ema(c,26), m = a.map((x,i)=>x-b[i]), s = ema(m,9); return m.map((x,i)=>x-s[i]); }

function marketOpen(ts){ const d = new Date(ts), day = d.getUTCDay(), h = d.getUTCHours();
  return !(day === 6 || (day === 5 && h >= 22) || (day === 0 && h < 23)); }
function inSession(ts){ const h = new Date(ts).getUTCHours(); return h >= 6 && h < 20; }

function aggregate(b, ms){ const o = []; for (const x of b){ const t = Math.floor(x.t/ms)*ms, k = o[o.length-1];
  if (k && k.t === t){ k.h = Math.max(k.h,x.h); k.l = Math.min(k.l,x.l); k.c = x.c; k.v += x.v || 0; } else o.push({t,o:x.o,h:x.h,l:x.l,c:x.c,v:x.v||0}); } return o; }

// Nearest supply (swing high above price) and demand (swing low below price), using only bars already confirmed at bar i.
function zones(m, i, look = 160, w = 3){ let res = null, sup = null; const c = m[i].c;
  for (let j = Math.max(w, i-look); j <= i-w; j++){ let ph = true, pl = true;
    for (let k = j-w; k <= j+w; k++){ if (m[k].h > m[j].h) ph = false; if (m[k].l < m[j].l) pl = false; }
    if (ph && m[j].h > c && (res === null || m[j].h < res)) res = m[j].h;
    if (pl && m[j].l < c && (sup === null || m[j].l > sup)) sup = m[j].l; }
  return { res, sup }; }

// Support and resistance: swing points clustered into the levels where price has turned most often.
function levels(m, look = 300, w = 4){ const n = m.length, s = Math.max(w, n-look), piv = [], a = atr(m)[n-1] || 1;
  for (let j = s; j < n-w; j++){ let ph = true, pl = true;
    for (let k = j-w; k <= j+w; k++){ if (m[k].h > m[j].h) ph = false; if (m[k].l < m[j].l) pl = false; }
    if (ph) piv.push(m[j].h); if (pl) piv.push(m[j].l); }
  piv.sort((x, y) => x - y); const out = [];
  for (const p of piv){ const g = out[out.length-1];
    if (g && p - g.price <= 0.6*a){ g.price = (g.price*g.touches + p)/(g.touches+1); g.touches++; } else out.push({ price: p, touches: 1 }); }
  const c = m[n-1].c;
  return out.filter(g => g.touches >= 2).sort((x, y) => y.touches - x.touches).slice(0, 6).map(g => ({ price: g.price, touches: g.touches, kind: g.price > c ? 'R' : 'S' })); }

// Regression channel over the last `len` closes: a midline with a band two standard deviations either side.
function channel(m, len = 80){ const n = m.length; if (n < len) return null; const i0 = n-len; let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let k = 0; k < len; k++){ const y = m[i0+k].c; sx += k; sy += y; sxy += k*y; sxx += k*k; }
  const slope = (len*sxy - sx*sy)/(len*sxx - sx*sx), b = (sy - slope*sx)/len; let ss = 0;
  for (let k = 0; k < len; k++){ const d = m[i0+k].c - (b + slope*k); ss += d*d; }
  const w = 2*Math.sqrt(ss/len), end = b + slope*(len-1), c = m[n-1].c;
  return { i0, i1: n-1, start: b, end, slope, width: w, pos: c > end + w ? 'above' : c < end - w ? 'below' : 'inside' }; }

function emaCrosses(e20, e50, from){ const o = [];
  for (let i = Math.max(1, from); i < e20.length; i++){ const a = e20[i-1]-e50[i-1], b = e20[i]-e50[i];
    if (a <= 0 && b > 0) o.push({ i, up: true }); else if (a >= 0 && b < 0) o.push({ i, up: false }); } return o; }

// m: closed 15m bars, h: closed 1h bars, eur: closed 1h EUR/USD bars or null (dollar proxy).
// Checks per side, in order: trend, stack, pullback, volatility, room | momentum, macd, strength, volume, dollar.
function analyze(m, h, eur){
  const c = m.map(x=>x.c), e20 = ema(c,20), e50 = ema(c,50), R = rsi(c), A = atr(m), X = adx(m), H = macdHist(c);
  const vol = m.map(x=>x.v||0), va = sma(vol,20), aa = sma(A,96);
  const hc = h.map(x=>x.c), h50 = ema(hc,50), h200 = ema(hc,200);
  const ec = eur ? eur.map(x=>x.c) : [], ee20 = ema(ec.length?ec:[0],20), ee50 = ema(ec.length?ec:[0],50);
  const n = m.length, dir = new Array(n).fill(0), score = new Array(n).fill(0), checks = new Array(n).fill(null);
  let p = -1, q = -1;
  for (let i = 0; i < n; i++){
    const tc = m[i].t + M15;
    while (p+1 < h.length && h[p+1].t + H1 <= tc) p++;
    while (eur && q+1 < eur.length && eur[q+1].t + H1 <= tc) q++;
    if (i < WARM || p < 60) continue;
    const z = zones(m, i), risk = ATR_MULT*A[i], volRatio = aa[i] ? A[i]/aa[i] : 1, relVol = va[i] ? vol[i]/va[i] : 0;
    const eurUp = q >= 55 ? ee20[q] > ee50[q] : null;   // euro rising means dollar falling
    const side = d => {
      const trend = d > 0 ? (h50[p] > h200[p] && hc[p] > h50[p]) : (h50[p] < h200[p] && hc[p] < h50[p]);
      const stack = d > 0 ? e20[i] > e50[i] : e20[i] < e50[i];
      let touched = false;
      for (let j = i-2; j <= i; j++) if (d > 0 ? m[j].l <= e20[j] + 0.25*A[j] : m[j].h >= e20[j] - 0.25*A[j]) touched = true;
      const pull = touched && (d > 0 ? (c[i] > e20[i] && c[i] > m[i].o) : (c[i] < e20[i] && c[i] < m[i].o));
      const calm = volRatio >= 0.6 && volRatio <= 1.8;
      const room = d > 0 ? (z.res === null || z.res - c[i] >= risk) : (z.sup === null || c[i] - z.sup >= risk);
      const mom = d > 0 ? (R[i] >= 45 && R[i] <= 70) : (R[i] <= 55 && R[i] >= 30);
      const macd = d > 0 ? H[i] > H[i-1] : H[i] < H[i-1];
      const strength = X[i] >= 18;
      const volume = relVol > 1;
      const dollar = eurUp === null ? null : (d > 0 ? eurUp : !eurUp);
      const list = [trend, stack, pull, calm, room, mom, macd, strength, volume, dollar];
      const extras = [mom, macd, strength, volume].concat(dollar === null ? [] : [dollar]);
      const extra = extras.filter(Boolean).length, need = extras.length >= 5 ? 3 : 2;
      return { list, go: trend && stack && pull && calm && room && extra >= need,
               total: list.filter(x => x === true).length, outOf: list.filter(x => x !== null).length };
    };
    const L = side(1), S = side(-1);
    checks[i] = { long: L, short: S, volRatio, relVol, res: z.res, sup: z.sup, dollarUp: eurUp === null ? null : !eurUp };
    const tradable = marketOpen(tc) && inSession(tc);
    if (tradable && L.go){ dir[i] = 1; score[i] = L.total; }
    else if (tradable && S.go){ dir[i] = -1; score[i] = S.total; }
  }
  return { e20, e50, atr: A, dir, score, checks };
}

// Strategy 2, stop-hunt reversal. Price spikes through yesterday's high or low, or the Asian-session high or low,
// where many stops sit, then closes back inside on the same candle. Trade the rejection; stop just beyond the spike.
function sweepSignals(m, A0){
  const n = m.length, dir = new Array(n).fill(0), risk = new Array(n).fill(0), score = new Array(n).fill(0);
  let day = null, pdH = null, pdL = null, curH = -Infinity, curL = Infinity, asH = null, asL = null, used = {};
  for (let i = 0; i < n; i++){
    if (!marketOpen(m[i].t)) continue;
    const key = Math.floor(m[i].t/86400000), hr = new Date(m[i].t).getUTCHours(), b = m[i], a = A0.atr[i], tc = b.t + M15;
    if (key !== day){ if (day !== null && curH > -Infinity){ pdH = curH; pdL = curL; } day = key; curH = -Infinity; curL = Infinity; asH = null; asL = null; used = {}; }
    if (hr < 6){ asH = asH === null ? b.h : Math.max(asH, b.h); asL = asL === null ? b.l : Math.min(asL, b.l); }
    if (i >= WARM && a > 0 && inSession(tc) && marketOpen(tc)){
      const lv = [['pdH', pdH, -1], ['pdL', pdL, 1], ['asH', hr >= 6 ? asH : null, -1], ['asL', hr >= 6 ? asL : null, 1]];
      for (const [k, p, d] of lv){
        if (p === null || used[k] || dir[i]) continue;
        if (d < 0 && b.h > p + 0.1*a && b.c < p && b.c < b.o){ const r = b.h + 0.25*a - b.c; if (r >= 0.5*a && r <= 2.5*a){ dir[i] = -1; risk[i] = r; score[i] = 1; used[k] = 1; } }
        if (d > 0 && b.l < p - 0.1*a && b.c > p && b.c > b.o){ const r = b.c - (b.l - 0.25*a); if (r >= 0.5*a && r <= 2.5*a){ dir[i] = 1; risk[i] = r; score[i] = 1; used[k] = 1; } }
      }
    }
    curH = Math.max(curH, b.h); curL = Math.min(curL, b.l);
  }
  return { dir, risk, score };
}

// Strategy 3, squeeze breakout. Bollinger bands at their tightest fifth of the last 120 candles, then a close
// outside the band on above-average volume, in the direction of the 1-hour trend.
function squeezeSignals(m, A0){
  const n = m.length, c = m.map(x => x.c), mid = sma(c, 20), vol = m.map(x => x.v || 0), va = sma(vol, 20);
  const sd = new Array(n).fill(0), width = new Array(n).fill(0), dir = new Array(n).fill(0), risk = new Array(n).fill(0), score = new Array(n).fill(0);
  for (let i = 19; i < n; i++){ let ss = 0; for (let k = i-19; k <= i; k++) ss += (c[k]-mid[i])*(c[k]-mid[i]); sd[i] = Math.sqrt(ss/20); width[i] = mid[i] ? 4*sd[i]/mid[i] : 0; }
  for (let i = Math.max(WARM, 141); i < n; i++){
    const ck = A0.checks[i], tc = m[i].t + M15; if (!ck || !(marketOpen(tc) && inSession(tc))) continue;
    const win = width.slice(i-120, i).sort((x, y) => x - y), tight = width[i-1] <= win[24];
    if (!tight || !(vol[i] > va[i])) continue;
    const up = mid[i-1] + 2*sd[i-1], lo = mid[i-1] - 2*sd[i-1];
    if (c[i] > up && ck.long.list[0]){ dir[i] = 1; risk[i] = ATR_MULT*A0.atr[i]; score[i] = 1; }
    else if (c[i] < lo && ck.short.list[0]){ dir[i] = -1; risk[i] = ATR_MULT*A0.atr[i]; score[i] = 1; }
  }
  return { dir, risk, score };
}

// General simulator: each entry has a signal bar i (entry at the next open), a direction, a stop, an optional target,
// and an optional trailing stop that can only tighten. Stop is checked before target in the same bar.
function runTrail(m, entries, spread){
  const trades = []; let busy = -1;
  for (const e of entries){
    if (e.i <= busy || e.i + 1 >= m.length) continue;
    const d = e.dir, entry = m[e.i+1].o; let stop = e.stop(entry); const risk = Math.abs(entry - stop); if (!(risk > 0)) continue;
    const target = e.target ? e.target(entry, risk) : null, cost = spread/risk; let out = null, j;
    for (j = e.i+1; j < m.length; j++){
      const b = m[j];
      if (d > 0 ? b.l <= stop : b.h >= stop){ out = d*(stop - entry)/risk; break; }
      if (target !== null && (d > 0 ? b.h >= target : b.l <= target)){ out = d*(target - entry)/risk; break; }
      if (e.trail){ const ns = e.trail(j); if (ns !== null && (d > 0 ? ns > stop : ns < stop)) stop = ns; }
    }
    if (out === null){ trades.open = { dir: d, time: m[e.i+1].t, entry, sl: stop, tp: null, risk, score: 0 }; break; }
    trades.push({ time: m[e.i+1].t, exit: m[j].t, dir: d, entry, r: out - cost }); busy = j;
  }
  return trades;
}

// Multi-hour breakout (trend following): a bar closes beyond the highest high or lowest low of the previous 20 bars.
// Stop 2 ATR away, then trailed to the opposite extreme of the last 10 bars. No fixed target: winners run.
// Weekend candles are dropped so a 24/7 gold token behaves like XAUUSD.
function breakoutTF(m0, tf, o){ o = o || {}; const N = 20, stopK = o.stopK || 2, trailN = o.trailN || 10;
  const m = m0.filter(b => marketOpen(b.t)), b = aggregate(m, tf), A = atr(b, 14), of = new Array(m.length), last = [], entries = []; let k = 0;
  for (let j = 0; j < m.length; j++){ while (b[k].t + tf <= m[j].t) k++; of[j] = k; }
  for (let j = 0; j < m.length; j++) if (j === m.length-1 || of[j+1] !== of[j]) last[of[j]] = j;
  for (let q = 30; q < b.length-1; q++){
    const i = last[q]; if (i === undefined) continue;
    let hh = -Infinity, ll = Infinity; for (let z = q-N; z < q; z++){ hh = Math.max(hh, b[z].h); ll = Math.min(ll, b[z].l); }
    const d = b[q].c > hh ? 1 : b[q].c < ll ? -1 : 0; if (!d) continue;
    const a = A[q];
    entries.push({ i, dir: d, stop: en => en - d*stopK*a, target: null,
      trail: j => { const kk = of[j]; if (kk - trailN < 0) return null; let x = d > 0 ? Infinity : -Infinity;
        for (let z = kk-trailN; z < kk; z++) x = d > 0 ? Math.min(x, b[z].l) : Math.max(x, b[z].h); return x; } });
  }
  return runTrail(m, entries, o.spread || 0);
}

// Live view of the 4-hour breakout from closed 1-hour bars: the levels a breakout needs, the latest completed 4-hour bar,
// and where the trailing stop sits for an open buy or sell.
function bo4hState(h){
  const hh0 = h.filter(x => marketOpen(x.t)), b = aggregate(hh0, 4*H1);
  // the newest 4-hour candle only counts once its last hour has closed; until then it is still forming
  if (b.length && hh0.length && hh0[hh0.length-1].t + H1 < b[b.length-1].t + 4*H1) b.pop();
  const n = b.length; if (n < 32) return null;
  const A = atr(b, 14), q = n-1, ext = (from, to, f) => { let x = f === 'h' ? -Infinity : Infinity; for (let z = from; z < to; z++) x = f === 'h' ? Math.max(x, b[z].h) : Math.min(x, b[z].l); return x; };
  const hh = ext(q-20, q, 'h'), ll = ext(q-20, q, 'l');
  return { lastEnd: b[q].t + 4*H1, dir: b[q].c > hh ? 1 : b[q].c < ll ? -1 : 0, atr: A[q],
    nextHi: ext(n-20, n, 'h'), nextLo: ext(n-20, n, 'l'), trailLong: ext(n-10, n, 'l'), trailShort: ext(n-10, n, 'h') };
}

const STRATS = { bo4h: '4-hour breakout', pullback: 'Trend pullback', sweep: 'Stop-hunt reversal', squeeze: 'Squeeze breakout' };
// Runs the chosen strategy. The trend-pullback analysis always runs too, because the chart and tiles read from it.
function strategy(name, m, h, eur, pre){
  const A0 = pre || analyze(m, h, eur);
  if (name === 'sweep') return Object.assign({}, A0, sweepSignals(m, A0), { name });
  if (name === 'squeeze') return Object.assign({}, A0, squeezeSignals(m, A0), { name });
  if (name === 'bo4h'){
    const bo = bo4hState(h), dir = new Array(m.length).fill(0), risk = new Array(m.length).fill(0), score = new Array(m.length).fill(0);
    if (bo && bo.dir){ for (let i = m.length-1; i >= 0 && m[i].t + M15 >= bo.lastEnd; i--) if (m[i].t + M15 === bo.lastEnd){ dir[i] = bo.dir; risk[i] = 2*bo.atr; score[i] = 1; } }
    return Object.assign({}, A0, { dir, risk, score, name, bo });
  }
  return Object.assign(A0, { name: 'pullback' });
}

// Walks the history with the same rules. One trade at a time; if stop and target fall in one bar, the stop counts.
// opt.be: move the stop to entry once price has run one full risk in favour. opt.spread: price cost charged per trade.
function simulate(m, A, liveBar, opt){
  opt = opt || {};
  const bars = liveBar ? m.concat([liveBar]) : m, nC = m.length, trades = []; let open = null, i = WARM;
  while (i < nC){
    const d = A.dir[i];
    if (d && i+1 < bars.length){
      const rr = opt.rr || RR, entry = bars[i+1].o, risk = (A.risk && A.risk[i] ? A.risk[i] : ATR_MULT*A.atr[i]) * (opt.stopScale || 1), cost = opt.spread ? opt.spread/risk : 0;
      const t = { dir: d, time: bars[i+1].t, entry, sl: entry - d*risk, tp: entry + d*risk*rr, risk, score: A.score[i], atEntry: false };
      let done = false;
      for (let j = i+1; j < bars.length; j++){
        const b = bars[j];
        const hitSL = d > 0 ? b.l <= t.sl : b.h >= t.sl, hitTP = d > 0 ? b.h >= t.tp : b.l <= t.tp;
        if (hitSL){ t.r = (t.atEntry ? 0 : -1) - cost; done = true; }
        else if (hitTP){ t.r = rr - cost; done = true; }
        else if (j - i >= MAXHOLD && j < nC){ t.r = d*(b.c-entry)/risk - cost; done = true; }
        else if (opt.be && !t.atEntry && (d > 0 ? b.h >= entry + risk : b.l <= entry - risk)){ t.atEntry = true; t.sl = entry; }
        if (done){ t.exit = b.t; trades.push(t); i = j; break; }
      }
      if (!done){ open = t; break; }
    }
    i++;
  }
  return { trades, open };
}

// Results split into k equal stretches of time: does the edge show up in most of them, or only in one lucky stretch?
function periods(trades, t0, t1, k){ const w = (t1 - t0)/k, out = [];
  for (let j = 0; j < k; j++){ const a = t0 + j*w, b = a + w, tr = trades.filter(t => t.time >= a && (j === k-1 ? t.time <= t1 : t.time < b));
    out.push({ start: a, n: tr.length, netR: tr.reduce((x, t) => x + t.r, 0) }); } return out; }

// Shuffles the same trades into many random orders to see how bad a losing run could realistically get.
function stress(rs, runs, seed){ let s = seed || 12345; const rnd = () => (s = (s*16807) % 2147483647)/2147483647;
  const dds = [], streaks = [], a = rs.slice();
  for (let k = 0; k < runs; k++){
    for (let i = a.length-1; i > 0; i--){ const j = Math.floor(rnd()*(i+1)); const x = a[i]; a[i] = a[j]; a[j] = x; }
    let eq = 0, peak = 0, dd = 0, run = 0, worst = 0;
    for (const r of a){ eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); run = r < 0 ? run + 1 : 0; worst = Math.max(worst, run); }
    dds.push(dd); streaks.push(worst); }
  dds.sort((x, y) => x - y); streaks.sort((x, y) => x - y); const q = arr => arr.length ? arr[Math.floor(0.95*(arr.length-1))] : 0;
  return { dd95: q(dds), streak95: q(streaks) }; }

function losingStreak(rs){ let run = 0, worst = 0; for (const r of rs){ run = r < 0 ? run + 1 : 0; worst = Math.max(worst, run); } return worst; }

function summarize(trades){ const n = trades.length, w = trades.filter(t=>t.r>0).length;
  let gain = 0, loss = 0, eq = 0, peak = 0, dd = 0;
  for (const t of trades){ if (t.r > 0) gain += t.r; else loss -= t.r; eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n, wins: w, winRate: n ? 100*w/n : 0, netR: eq, profitFactor: loss ? gain/loss : (gain ? Infinity : 0), maxDD: dd }; }

function demoBars(now){ let s = 1234567; const rnd = () => (s = (s*16807)%2147483647)/2147483647;
  const out = []; let p = 4000, drift = 0; const end = Math.floor(now/M15)*M15;
  for (let i = 4400; i >= 0; i--){ if (i % 160 === 0) drift = (rnd()-0.5)*1.2;
    const o = p, c = o + drift + (rnd()-0.5)*7, h = Math.max(o,c)+rnd()*3, l = Math.min(o,c)-rnd()*3;
    out.push({ t: end - i*M15, o, h, l, c, v: 20 + rnd()*60 + Math.abs(c-o)*6 }); p = c; } return out; }

// Lots for a given risk. Rounds down to the broker's step; returns 0 when even the minimum lot would risk too much.
function lotSize(balance, riskPct, riskPrice, spec){
  const cs = spec.contractSize || 100, step = spec.volumeStep || 0.01, mn = spec.minVolume || 0.01, mx = spec.maxVolume || 50;
  if (!(balance > 0) || !(riskPct > 0) || !(riskPrice > 0)) return 0;
  let lots = Math.floor((balance*riskPct/100) / (riskPrice*cs) / step + 1e-9) * step;
  if (lots < mn) return 0; if (lots > mx) lots = mx;
  return Math.round(lots*1000)/1000; }
// ENGINE-END
module.exports = { bo4hState, breakoutTF, lotSize, marketOpen, summarize, aggregate };
