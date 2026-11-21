// Gold Signal Desk cloud bot. Runs once an hour on GitHub's servers and trades the practice account
// with the 4-hour breakout. The trading rules are read from the app itself (app/src/main/assets/index.html),
// so the phone app and this bot can never drift apart.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..'), DATA = path.join(__dirname, 'data');
const H1 = 3600000, MIN = 60000, CS = 100;
const SPEC = { contractSize: CS, volumeStep: 0.01, minVolume: 0.01, maxVolume: 50 };

function engine(){ return require('./engine.js'); }
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e){ return d; } };

async function getJSON(url){
  for (let a = 0; a < 3; a++){
    try { const r = await fetch(url, { headers: { 'User-Agent': 'gold-signal-desk-bot' } }); if (r.ok) return await r.json(); }
    catch(e){}
    await new Promise(r => setTimeout(r, 1500*(a+1)));
  }
  throw new Error('no answer from ' + url.split('/')[2]);
}
// Refuse a feed whose newest hourly candle is more than two hours old: acting on stale prices is worse than skipping a run.
function fresh(bars){ if (bars.length < 200) throw new Error('too few candles'); const age = Date.now() - bars[bars.length-1].t;
  if (age > 2*H1) throw new Error('stale prices, newest candle ' + Math.round(age/H1) + ' hours old'); }
// 1-hour PAX Gold candles, newest last. Binance first, Coinbase if Binance is unreachable.
async function hourly(){
  const out = [];
  try {
    // the limit changes every minute so no cache in between can hand back an old copy
    const j = await getJSON('https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=1h&limit=' + (990 + Math.floor(Date.now()/60000) % 10));
    const bars = j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    fresh(bars); return { src: 'Binance', bars };
  } catch(e){ out.push('Binance: ' + e.message); }
  try {
    let end = Math.floor(Date.now()/1000), all = [];
    for (let k = 0; k < 3; k++){
      const start = end - 300*3600;
      const j = await getJSON('https://api.exchange.coinbase.com/products/PAXG-USD/candles?granularity=3600&start=' + new Date(start*1000).toISOString() + '&end=' + new Date(end*1000).toISOString());
      all = j.map(x => ({ t: x[0]*1000, o: +x[3], h: +x[2], l: +x[1], c: +x[4], v: +x[5] })).concat(all); end = start;
    }
    const seen = new Set(); all = all.filter(b => !seen.has(b.t) && seen.add(b.t)).sort((a, b) => a.t - b.t);
    fresh(all); return { src: 'Coinbase', bars: all };
  } catch(e){ out.push('Coinbase: ' + e.message); }
  throw new Error('no price source answered (' + out.join('; ') + ')');
}
async function newsNow(pauseMin){
  try {
    const j = await getJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json'), now = Date.now();
    const ev = j.filter(e => e.country === 'USD' && e.impact === 'High').map(e => ({ title: e.title, t: Date.parse(e.date) }));
    return { ok: true, hit: ev.find(e => Math.abs(e.t - now) < pauseMin*MIN) || null, next: ev.filter(e => e.t > now).sort((a, b) => a.t - b.t).slice(0, 5) };
  } catch(e){ return { ok: false, hit: null, next: [] }; }
}

async function main(){
  const E = engine(), cfg = readJSON(path.join(__dirname, 'config.json'), {}), now = Date.now();
  const SP = cfg.spread || 0.4;
  fs.mkdirSync(DATA, { recursive: true });
  const stateFile = path.join(DATA, 'state.json');
  const st = readJSON(stateFile, null) || { start: cfg.startBalance || 10000, balance: cfg.startBalance || 10000, pos: null, history: [], lastSignalEnd: 0, log: [] };
  const log = (m, k) => { st.log.unshift({ t: now, m, k: k || '' }); st.log = st.log.slice(0, 200); console.log(m); };

  let feed;
  try { feed = await hourly(); }
  catch(e){ log('Run skipped: ' + e.message, 'e'); st.lastRun = now; st.lastError = e.message; fs.writeFileSync(stateFile, JSON.stringify(st, null, 1)); return writeStatus(E, st, null, null, null, cfg); }
  const bars = feed.bars, closed = bars.filter(b => b.t + H1 <= now), price = bars[bars.length-1].c, open = E.marketOpen(now);
  const bo = E.bo4hState(closed);

  // 1. manage the open practice trade: stop hits on every hour since the last check, then trail the stop
  if (st.pos){
    const p = st.pos;
    for (const b of bars){
      if (b.t < p.checkFrom || !E.marketOpen(b.t)) continue;
      if (p.dir > 0 ? b.l <= p.sl : b.h >= p.sl){ closeTrade(p.sl, p.dir*(p.sl - p.entry) > 0 ? 'trailing stop, in profit' : 'stop loss', Math.min(now, b.t + H1)); break; }
      if (b.t + H1 <= now) p.checkFrom = b.t + H1;
    }
    if (st.pos && bo){
      const ns = p.dir > 0 ? bo.trailLong : bo.trailShort;
      if (isFinite(ns) && (p.dir > 0 ? ns > p.sl : ns < p.sl)){
        if (p.dir > 0 ? ns >= price : ns <= price) closeTrade(price - p.dir*SP/2, 'trailing stop', now);   // the new stop is already behind the price
        else { log('Trailing stop moved from ' + p.sl.toFixed(2) + ' to ' + ns.toFixed(2) + '.', 't'); p.sl = ns; }
      }
    }
  }
  function closeTrade(exit, why, t){
    const p = st.pos, pl = p.dir*(exit - p.entry)*p.lots*CS;
    st.balance += pl;
    st.history.unshift({ open: p.time, t, dir: p.dir, lots: p.lots, entry: p.entry, exit, pl, r: p.dir*(exit - p.entry)/p.risk, why });
    st.history = st.history.slice(0, 500); st.pos = null;
    log('Trade closed at ' + exit.toFixed(2) + ' (' + why + '): ' + (pl >= 0 ? 'profit ' : 'loss ') + Math.abs(pl).toFixed(2) + ' USD.', pl < 0 ? 'e' : 't');
  }

  // 2. a new 4-hour breakout
  const news = await newsNow(cfg.newsPauseMinutes || 30);
  if (bo && bo.dir && bo.lastEnd > (st.lastSignalEnd || 0)){
    st.lastSignalEnd = bo.lastEnd;
    const side = bo.dir > 0 ? 'BUY' : 'SELL', skip = w => log(side + ' breakout skipped: ' + w);
    const risk = 2*bo.atr, lots = E.lotSize(st.balance, cfg.riskPercent || 1, risk, SPEC);
    if (now - bo.lastEnd > (cfg.enterWithinMinutes || 120)*MIN) skip('the bot ran too long after the 4-hour close.');
    else if (!open) skip('the gold market is closed.');
    else if (st.pos) skip('a trade is already open.');
    else if (news.hit) skip('news pause for ' + news.hit.title + '.');
    else if (!lots) skip('the balance is too small for the minimum lot at this risk.');
    else {
      const entry = price + bo.dir*SP/2;
      st.pos = { dir: bo.dir, lots, entry, sl: entry - bo.dir*risk, risk, time: now, checkFrom: Math.floor(now/H1)*H1, signalEnd: bo.lastEnd };
      log(side + ' ' + lots + ' lots at ' + entry.toFixed(2) + ', stop ' + st.pos.sl.toFixed(2) + ', trailing, no fixed target.', 't');
    }
  }

  st.lastRun = now; st.lastError = null; st.source = feed.src;
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 1));
  writeStatus(E, st, bo, price, news, cfg);
}

// A small summary the phone app reads.
function writeStatus(E, st, bo, price, news, cfg){
  const H = st.history, wins = H.filter(x => x.pl > 0).length, net = H.reduce((a, x) => a + x.pl, 0), p = st.pos;
  const status = {
    updated: st.lastRun, error: st.lastError || null, source: st.source || null, price,
    strategy: cfg.strategy, riskPercent: cfg.riskPercent,
    account: { start: st.start, balance: st.balance, equity: p && price ? st.balance + p.dir*(price - p.dir*(cfg.spread || 0.4)/2 - p.entry)*p.lots*CS : st.balance },
    position: p ? { dir: p.dir, lots: p.lots, entry: p.entry, stop: p.sl, opened: p.time } : null,
    levels: bo ? { buyAbove: bo.nextHi, sellBelow: bo.nextLo, nextClose: bo.lastEnd + 4*H1, atr: bo.atr } : null,
    record: { trades: H.length, wins, net, lastTrades: H.slice(0, 30) },
    news: news ? news.next : [], log: st.log.slice(0, 40)
  };
  fs.writeFileSync(path.join(DATA, 'status.json'), JSON.stringify(status, null, 1));
}
// Print a short summary on every run, so the GitHub log always shows what the bot saw.
function printSummary(){
  const s = JSON.parse(fs.readFileSync(path.join(DATA, 'status.json'), 'utf8'));
  const ist = t => (t && isFinite(t)) ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '-';
  const n = x => (x == null || !isFinite(x)) ? '-' : Number(x).toFixed(2);
  console.log('----- Gold Signal Desk, ' + ist(s.updated) + ' IST -----');
  if (s.error) console.log('Problem: ' + s.error);
  console.log('Price: ' + n(s.price) + ' USD (' + (s.source || 'no source') + ')');
  if (s.levels) console.log('4-hour breakout: buy above ' + n(s.levels.buyAbove) + ', sell below ' + n(s.levels.sellBelow) + ', next 4-hour close ' + ist(s.levels.nextClose));
  else console.log('4-hour breakout: no levels yet');
  const p = s.position;
  console.log('Open trade: ' + (p ? (p.dir > 0 ? 'BUY ' : 'SELL ') + p.lots + ' lots at ' + n(p.entry) + ', stop ' + n(p.stop) : 'none'));
  console.log('Practice account: balance ' + n(s.account.balance) + ' USD, equity ' + n(s.account.equity) + ' USD (started at ' + n(s.account.start) + ')');
  console.log('Closed trades: ' + s.record.trades + ', wins ' + s.record.wins + ', net ' + n(s.record.net) + ' USD');
  if (s.news && s.news.length) console.log('Next big USD news: ' + s.news[0].title + ', ' + ist(s.news[0].t));
}

if (require.main === module) main().then(() => { try { printSummary(); } catch(e){ console.log('Summary not available: ' + e.message); } }).catch(e => { console.error(e); process.exit(1); });
module.exports = { main, DATA };
