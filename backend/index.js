// Backend (Cloudflare Worker): esconde a chave do OpenWeather e junta clima + maré + risco.
// Fontes: OpenWeather (clima/chuva, chave grátis) e Open-Meteo Marine (maré, sem chave).

const UP = { cf: { cacheTtl: 600, cacheEverything: true } };
const TILE_LAYERS = ['precipitation_new', 'clouds_new', 'wind_new', 'pressure_new'];

const get = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`Upstream ${r.status} (${new URL(url).hostname})`);
  return r;
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = { 'access-control-allow-origin': env.ALLOWED_ORIGIN || '*' };
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'access-control-allow-methods': 'GET' } });
    }
    try {
      if (!env.OPENWEATHER_KEY) throw new Error('OPENWEATHER_KEY não configurada');

      if (url.pathname === '/api/forecast') {
        const lat = +(+url.searchParams.get('lat')).toFixed(2);
        const lon = +(+url.searchParams.get('lon')).toFixed(2);
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
          return Response.json({ error: 'lat/lon inválidos' }, { status: 400, headers: cors });
        }
        const data = await forecast(lat, lon, env.OPENWEATHER_KEY);
        return Response.json(data, { headers: { ...cors, 'cache-control': 'public, max-age=300' } });
      }

      // Proxy de tiles do OpenWeather (a chave nunca vai para o navegador)
      const m = url.pathname.match(/^\/api\/tiles\/(\w+)\/(\d+)\/(\d+)\/(\d+)$/);
      if (m && TILE_LAYERS.includes(m[1])) {
        const [, layer, z, x, y] = m;
        const r = await get(
          `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${env.OPENWEATHER_KEY}`,
          { cf: { cacheTtl: 1800, cacheEverything: true } }
        );
        return new Response(r.body, {
          headers: { ...cors, 'content-type': 'image/png', 'cache-control': 'public, max-age=1800' },
        });
      }
      return Response.json({ error: 'not found' }, { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors });
    }
  },
};

async function forecast(lat, lon, key) {
  const ow = (p) =>
    get(`https://api.openweathermap.org/data/2.5/${p}?lat=${lat}&lon=${lon}&units=metric&lang=pt_br&appid=${key}`, UP).then((r) => r.json());
  const [cur, fc, sea] = await Promise.all([
    ow('weather'),
    ow('forecast'),
    get(
      `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=sea_level_height_msl,wave_height&timezone=GMT&timeformat=unixtime&forecast_days=3`,
      UP
    ).then((r) => r.json()),
  ]);

  const nowS = Math.floor(Date.now() / 1000);
  const hr = sea.hourly || {};
  const tide = (hr.time || [])
    .map((t, i) => ({ t, h: hr.sea_level_height_msl?.[i], wave: hr.wave_height?.[i] }))
    .filter((p) => p.h != null && p.t >= nowS - 3600);

  // OpenWeather: cada bloco de 3h termina em `t`
  const rain = fc.list.map((f) => ({ t: f.dt, mm: f.rain?.['3h'] || 0, pop: f.pop || 0 }));

  const extremes = [];
  for (let i = 1; i < tide.length - 1; i++) {
    const a = tide[i - 1].h, b = tide[i].h, c = tide[i + 1].h;
    if (b > a && b >= c) extremes.push({ t: tide[i].t, h: b, type: 'preamar' });
    else if (b < a && b <= c) extremes.push({ t: tide[i].t, h: b, type: 'baixa-mar' });
  }

  return {
    location: { lat, lon, name: cur.name || '' },
    now: {
      temp: cur.main.temp, feels: cur.main.feels_like, humidity: cur.main.humidity,
      pressure: cur.main.pressure, wind: cur.wind.speed, gust: cur.wind.gust ?? null,
      desc: cur.weather[0].description, icon: cur.weather[0].icon,
    },
    rain, tide, extremes,
    risk: risk(tide, rain, cur, nowS),
  };
}

// Índice simples e transparente: maré alta + chuva + ondas + vento + pressão baixa.
function risk(tide, rain, cur, nowS) {
  const reasons = [];
  let score = 0;
  const add = (pts, txt) => { if (pts) { score += pts; reasons.push(txt); } };

  const tideMax = Math.max(...tide.filter((p) => p.t < nowS + 48 * 3600).map((p) => p.h), -Infinity);
  const waveMax = Math.max(...tide.map((p) => p.wave ?? 0), 0);
  const rain24 = rain.filter((r) => r.t <= nowS + 24 * 3600).reduce((s, r) => s + r.mm, 0);
  const wind = Math.max(cur.wind.speed, cur.wind.gust ?? 0);

  if (isFinite(tideMax)) {
    add(tideMax >= 1.5 ? 3 : tideMax >= 1 ? 2 : tideMax >= 0.6 ? 1 : 0, `Maré prevista até ${tideMax.toFixed(2)} m acima do nível médio`);
  }
  add(rain24 >= 80 ? 3 : rain24 >= 40 ? 2 : rain24 >= 15 ? 1 : 0, `Chuva acumulada de ${rain24.toFixed(0)} mm nas próximas 24 h`);
  add(waveMax >= 3 ? 2 : waveMax >= 2 ? 1 : 0, `Ondas de até ${waveMax.toFixed(1)} m`);
  add(wind >= 15 ? 1 : 0, `Vento forte (${(wind * 3.6).toFixed(0)} km/h)`);
  add(cur.main.pressure < 1005 ? 1 : 0, `Pressão baixa (${cur.main.pressure} hPa)`);

  // Chuva forte coincidindo com maré alta dificulta o escoamento: agrava o risco
  const coincide = rain.some(
    (r) => r.mm >= 5 && r.t <= nowS + 48 * 3600 && tide.some((p) => p.t > r.t - 10800 && p.t <= r.t && p.h >= 0.6)
  );
  add(coincide ? 2 : 0, 'Chuva forte coincide com maré alta (drenagem prejudicada)');

  const level = score >= 7 ? 3 : score >= 5 ? 2 : score >= 3 ? 1 : 0;
  return { level, score, reasons, rain24, tideMax: isFinite(tideMax) ? tideMax : null };
}
