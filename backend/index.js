// Backend (Cloudflare Worker): junta clima + maré + rios + risco. Nenhuma chave de API necessária.
// Fontes: Open-Meteo (clima/chuva), Open-Meteo Marine (maré/ondas) e ANA (nível dos rios).

const UP = { cf: { cacheTtl: 600, cacheEverything: true } };

const get = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`Upstream ${r.status} (${new URL(url).hostname})`);
  return r;
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'access-control-allow-methods': 'GET' } });
    }
    try {
      if (url.pathname === '/api/forecast') {
        const lat = +(+url.searchParams.get('lat')).toFixed(2);
        const lon = +(+url.searchParams.get('lon')).toFixed(2);
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
          return Response.json({ error: 'lat/lon inválidos' }, { status: 400, headers: cors });
        }
        const data = await forecast(lat, lon);
        return Response.json(data, { headers: { ...cors, 'cache-control': 'public, max-age=300' } });
      }
      return Response.json({ error: 'not found' }, { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors });
    }
  },
};

async function forecast(lat, lon) {
  const [wx, sea, rios] = await Promise.all([
    get(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_gusts_10m,weather_code,is_day' +
        '&hourly=precipitation,precipitation_probability&wind_speed_unit=ms&timezone=GMT&timeformat=unixtime&forecast_days=3',
      UP
    ).then((r) => r.json()),
    get(
      `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=sea_level_height_msl,wave_height&timezone=GMT&timeformat=unixtime&forecast_days=3`,
      UP
    ).then((r) => r.json()),
    rivers(lat, lon).catch(() => null), // ANA é instável: falha aqui não derruba o resto
  ]);

  const nowS = Math.floor(Date.now() / 1000);
  const hr = sea.hourly || {};
  const tide = (hr.time || [])
    .map((t, i) => ({ t, h: hr.sea_level_height_msl?.[i], wave: hr.wave_height?.[i] }))
    .filter((p) => p.h != null && p.t >= nowS - 3600);

  // Open-Meteo: precipitação de cada hora termina no horário `t`
  const w = wx.hourly;
  const rain = w.time
    .map((t, i) => ({ t, mm: w.precipitation[i] || 0, pop: (w.precipitation_probability?.[i] || 0) / 100 }))
    .filter((r) => r.t >= nowS);

  // Extremos locais; oscilações < 15 cm entre um extremo e o seguinte são ruído do modelo
  const extremes = [];
  const push = (e) => {
    const last = extremes.at(-1);
    if (!last) extremes.push(e);
    else if (last.type === e.type) { if ((e.h - last.h) * (e.type === 'preamar' ? 1 : -1) > 0) extremes[extremes.length - 1] = e; }
    else if (Math.abs(e.h - last.h) >= 0.15) extremes.push(e);
  };
  for (let i = 1; i < tide.length - 1; i++) {
    const a = tide[i - 1].h, b = tide[i].h, c = tide[i + 1].h;
    if (b > a && b >= c) push({ t: tide[i].t, h: b, type: 'preamar' });
    else if (b < a && b <= c) push({ t: tide[i].t, h: b, type: 'baixa-mar' });
  }

  const c = wx.current;
  const now = {
    temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m,
    pressure: c.pressure_msl, wind: c.wind_speed_10m, gust: c.wind_gusts_10m ?? null,
    code: c.weather_code, day: !!c.is_day,
  };
  return {
    location: { lat, lon },
    now, rain, tide, extremes, rios,
    risk: risk(tide, rain, now, nowS, rios),
  };
}

// ---- ANA: telemetria de rios (serviço público, sem autenticação) ----
const ANA = 'http://telemetriaws1.ana.gov.br/ServiceANA.asmx/';
const ANA_ORIGENS = [5, 4]; // 5 = RHN (rede nacional), 4 = CotaOnline
const field = (s, k) => {
  const a = s.indexOf(`<${k}>`);
  if (a < 0) return '';
  const st = a + k.length + 2;
  return s.slice(st, s.indexOf('<', st)).trim();
};
const km = (la1, lo1, la2, lo2) => {
  const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};
const ymd = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10); // data em Brasília

async function rivers(lat, lon, maxKm = 60, max = 5) {
  const lists = await Promise.all(
    ANA_ORIGENS.map((o) =>
      get(`${ANA}ListaEstacoesTelemetricas?statusEstacoes=0&origem=${o}`, { cf: { cacheTtl: 86400, cacheEverything: true } }).then((r) => r.text())
    )
  );
  const cand = [];
  for (const xml of lists) {
    for (const row of xml.split('<Table ').slice(1)) {
      const la = +field(row, 'Latitude'), lo = +field(row, 'Longitude');
      if (Math.abs(la - lat) > 0.6 || Math.abs(lo - lon) > 0.6) continue; // pré-filtro barato
      const dist = km(lat, lon, la, lo);
      if (dist > maxKm || field(row, 'StatusEstacao') !== 'Ativo') continue;
      cand.push({
        cod: field(row, 'CodEstacao'), nome: field(row, 'NomeEstacao').replace(/&amp;/g, '&'),
        rio: field(row, 'NomeRio').replace(/&amp;/g, '&'), lat: la, lon: lo, dist: +dist.toFixed(1),
      });
    }
  }
  cand.sort((a, b) => a.dist - b.dist);

  const now = Date.now();
  const ini = ymd(now - 3 * 86400e3), fim = ymd(now);
  const out = await Promise.all(
    cand.slice(0, 10).map(async (s) => {
      try {
        const xml = await get(`${ANA}DadosHidrometeorologicos?codEstacao=${s.cod}&dataInicio=${ini}&dataFim=${fim}`, UP).then((r) => r.text());
        const pts = xml.split('<DadosHidrometereologicos ').slice(1).map((r) => ({
          t: Date.parse(field(r, 'DataHora').replace(' ', 'T') + '-03:00') / 1000,
          n: parseFloat(field(r, 'Nivel')), q: parseFloat(field(r, 'Vazao')), c: parseFloat(field(r, 'Chuva')),
        }));
        const lv = pts.filter((p) => isFinite(p.n) && isFinite(p.t)).sort((a, b) => a.t - b.t);
        if (lv.length < 3) return null;
        const last = lv.at(-1), nowS = now / 1000;
        const ref = lv.reduce((b, p) => (Math.abs(p.t - (last.t - 6 * 3600)) < Math.abs(b.t - (last.t - 6 * 3600)) ? p : b));
        const var6h = last.n - ref.n;
        const stale = nowS - last.t > 6 * 3600;
        const rise = stale ? 0 : var6h; // cm em ~6 h
        const nivel = stale ? null : rise >= 100 ? 3 : rise >= 50 ? 2 : rise >= 10 ? 1 : 0;
        const hourly = lv.filter((p, i) => i === lv.length - 1 || Math.floor(p.t / 3600) !== Math.floor(lv[i + 1].t / 3600));
        return {
          ...s, nivel, stale,
          ultimo: { t: last.t, cm: last.n, vazao: isFinite(last.q) ? last.q : null },
          var6h: +var6h.toFixed(0), max72: Math.max(...lv.map((p) => p.n)), min72: Math.min(...lv.map((p) => p.n)),
          chuva24: +pts.filter((p) => p.t > nowS - 86400 && p.c > 0).reduce((a, p) => a + p.c, 0).toFixed(1),
          serie: hourly.map((p) => [p.t, p.n]),
        };
      } catch { return null; }
    })
  );
  return out.filter(Boolean).slice(0, max);
}

// Índice simples e transparente: maré alta + chuva + ondas + vento + pressão baixa.
function risk(tide, rain, cur, nowS, rios) {
  const reasons = [];
  let score = 0;
  const add = (pts, txt) => { if (pts) { score += pts; reasons.push(txt); } };

  const tideMax = Math.max(...tide.filter((p) => p.t < nowS + 48 * 3600).map((p) => p.h), -Infinity);
  const waveMax = Math.max(...tide.map((p) => p.wave ?? 0), 0);
  const rain24 = rain.filter((r) => r.t <= nowS + 24 * 3600).reduce((s, r) => s + r.mm, 0);
  const wind = Math.max(cur.wind, cur.gust ?? 0);

  if (isFinite(tideMax)) {
    add(tideMax >= 1.5 ? 3 : tideMax >= 1 ? 2 : tideMax >= 0.6 ? 1 : 0, `Maré prevista até ${tideMax.toFixed(2)} m acima do nível médio`);
  }
  add(rain24 >= 80 ? 3 : rain24 >= 40 ? 2 : rain24 >= 15 ? 1 : 0, `Chuva acumulada de ${rain24.toFixed(0)} mm nas próximas 24 h`);
  add(waveMax >= 3 ? 2 : waveMax >= 2 ? 1 : 0, `Ondas de até ${waveMax.toFixed(1)} m`);
  add(wind >= 15 ? 1 : 0, `Vento forte (${(wind * 3.6).toFixed(0)} km/h)`);
  add(cur.pressure < 1005 ? 1 : 0, `Pressão baixa (${cur.pressure} hPa)`);

  // Chuva forte coincidindo com maré alta dificulta o escoamento: agrava o risco
  const coincide = rain.some(
    (r) => r.mm >= 3 && r.t <= nowS + 48 * 3600 && tide.some((p) => p.t > r.t - 3600 && p.t <= r.t && p.h >= 0.6)
  );
  add(coincide ? 2 : 0, 'Chuva forte coincide com maré alta (drenagem prejudicada)');

  // Rios (ANA): ritmo de subida do nível nas últimas ~6 h
  const worst = (rios || []).filter((r) => r.nivel > 0).sort((a, b) => b.nivel - a.nivel)[0];
  if (worst) add(worst.nivel, `Rio ${worst.rio || worst.nome} subindo ${worst.var6h} cm em ~6 h (estação ${worst.nome}, ANA)`);

  const level = score >= 7 ? 3 : score >= 5 ? 2 : score >= 3 ? 1 : 0;
  return { level, score, reasons, rain24, tideMax: isFinite(tideMax) ? tideMax : null };
}
