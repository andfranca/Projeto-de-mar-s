var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var UP = { cf: { cacheTtl: 600, cacheEverything: true } };
var get = /* @__PURE__ */ __name(async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`Upstream ${r.status} (${new URL(url).hostname})`);
  return r;
}, "get");
var index_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = { "access-control-allow-origin": env.ALLOWED_ORIGIN || "*" };
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...cors, "access-control-allow-methods": "GET" } });
    }
    try {
      if (url.pathname === "/api/forecast") {
        const lat = +(+url.searchParams.get("lat")).toFixed(2);
        const lon = +(+url.searchParams.get("lon")).toFixed(2);
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
          return Response.json({ error: "lat/lon inv\xE1lidos" }, { status: 400, headers: cors });
        }
        const data = await forecast(lat, lon);
        return Response.json(data, { headers: { ...cors, "cache-control": "public, max-age=300" } });
      }
      return Response.json({ error: "not found" }, { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors });
    }
  }
};
async function forecast(lat, lon) {
  const [wx, sea, rios] = await Promise.all([
    get(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_gusts_10m,weather_code,is_day&hourly=precipitation,precipitation_probability&wind_speed_unit=ms&timezone=GMT&timeformat=unixtime&forecast_days=3`,
      UP
    ).then((r) => r.json()),
    get(
      `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=sea_level_height_msl,wave_height&timezone=GMT&timeformat=unixtime&forecast_days=3`,
      UP
    ).then((r) => r.json()),
    rivers(lat, lon).catch(() => null)
    // ANA é instável: falha aqui não derruba o resto
  ]);
  const nowS = Math.floor(Date.now() / 1e3);
  const hr = sea.hourly || {};
  const tide = (hr.time || []).map((t, i) => ({ t, h: hr.sea_level_height_msl?.[i], wave: hr.wave_height?.[i] })).filter((p) => p.h != null && p.t >= nowS - 3600);
  const w = wx.hourly;
  const rain = w.time.map((t, i) => ({ t, mm: w.precipitation[i] || 0, pop: (w.precipitation_probability?.[i] || 0) / 100 })).filter((r) => r.t >= nowS);
  const extremes = [];
  const push = /* @__PURE__ */ __name((e) => {
    const last = extremes.at(-1);
    if (!last) extremes.push(e);
    else if (last.type === e.type) {
      if ((e.h - last.h) * (e.type === "preamar" ? 1 : -1) > 0) extremes[extremes.length - 1] = e;
    } else if (Math.abs(e.h - last.h) >= 0.15) extremes.push(e);
  }, "push");
  for (let i = 1; i < tide.length - 1; i++) {
    const a = tide[i - 1].h, b = tide[i].h, c2 = tide[i + 1].h;
    if (b > a && b >= c2) push({ t: tide[i].t, h: b, type: "preamar" });
    else if (b < a && b <= c2) push({ t: tide[i].t, h: b, type: "baixa-mar" });
  }
  const c = wx.current;
  const now = {
    temp: c.temperature_2m,
    feels: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    pressure: c.pressure_msl,
    wind: c.wind_speed_10m,
    gust: c.wind_gusts_10m ?? null,
    code: c.weather_code,
    day: !!c.is_day
  };
  return {
    location: { lat, lon },
    now,
    rain,
    tide,
    extremes,
    rios,
    risk: risk(tide, rain, now, nowS, rios)
  };
}
__name(forecast, "forecast");
var ANA = "http://telemetriaws1.ana.gov.br/ServiceANA.asmx/";
var ANA_ORIGENS = [5, 4];
var field = /* @__PURE__ */ __name((s, k) => {
  const a = s.indexOf(`<${k}>`);
  if (a < 0) return "";
  const st = a + k.length + 2;
  return s.slice(st, s.indexOf("<", st)).trim();
}, "field");
var km = /* @__PURE__ */ __name((la1, lo1, la2, lo2) => {
  const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}, "km");
var ymd = /* @__PURE__ */ __name((ms) => new Date(ms - 3 * 36e5).toISOString().slice(0, 10), "ymd");
async function rivers(lat, lon, maxKm = 60, max = 5) {
  const lists = await Promise.all(
    ANA_ORIGENS.map(
      (o) => get(`${ANA}ListaEstacoesTelemetricas?statusEstacoes=0&origem=${o}`, { cf: { cacheTtl: 86400, cacheEverything: true } }).then((r) => r.text())
    )
  );
  const cand = [];
  for (const xml of lists) {
    for (const row of xml.split("<Table ").slice(1)) {
      const la = +field(row, "Latitude"), lo = +field(row, "Longitude");
      if (Math.abs(la - lat) > 0.6 || Math.abs(lo - lon) > 0.6) continue;
      const dist = km(lat, lon, la, lo);
      if (dist > maxKm || field(row, "StatusEstacao") !== "Ativo") continue;
      cand.push({
        cod: field(row, "CodEstacao"),
        nome: field(row, "NomeEstacao").replace(/&amp;/g, "&"),
        rio: field(row, "NomeRio").replace(/&amp;/g, "&"),
        lat: la,
        lon: lo,
        dist: +dist.toFixed(1)
      });
    }
  }
  cand.sort((a, b) => a.dist - b.dist);
  const now = Date.now();
  const ini = ymd(now - 3 * 864e5), fim = ymd(now);
  const out = await Promise.all(
    cand.slice(0, 10).map(async (s) => {
      try {
        const xml = await get(`${ANA}DadosHidrometeorologicos?codEstacao=${s.cod}&dataInicio=${ini}&dataFim=${fim}`, UP).then((r) => r.text());
        const pts = xml.split("<DadosHidrometereologicos ").slice(1).map((r) => ({
          t: Date.parse(field(r, "DataHora").replace(" ", "T") + "-03:00") / 1e3,
          n: parseFloat(field(r, "Nivel")),
          q: parseFloat(field(r, "Vazao")),
          c: parseFloat(field(r, "Chuva"))
        }));
        const lv = pts.filter((p) => isFinite(p.n) && isFinite(p.t)).sort((a, b) => a.t - b.t);
        if (lv.length < 3) return null;
        const last = lv.at(-1), nowS = now / 1e3;
        const ref = lv.reduce((b, p) => Math.abs(p.t - (last.t - 6 * 3600)) < Math.abs(b.t - (last.t - 6 * 3600)) ? p : b);
        const var6h = last.n - ref.n;
        const stale = nowS - last.t > 6 * 3600;
        const rise = stale ? 0 : var6h;
        const nivel = stale ? null : rise >= 100 ? 3 : rise >= 50 ? 2 : rise >= 10 ? 1 : 0;
        const hourly = lv.filter((p, i) => i === lv.length - 1 || Math.floor(p.t / 3600) !== Math.floor(lv[i + 1].t / 3600));
        return {
          ...s,
          nivel,
          stale,
          ultimo: { t: last.t, cm: last.n, vazao: isFinite(last.q) ? last.q : null },
          var6h: +var6h.toFixed(0),
          max72: Math.max(...lv.map((p) => p.n)),
          min72: Math.min(...lv.map((p) => p.n)),
          chuva24: +pts.filter((p) => p.t > nowS - 86400 && p.c > 0).reduce((a, p) => a + p.c, 0).toFixed(1),
          serie: hourly.map((p) => [p.t, p.n])
        };
      } catch {
        return null;
      }
    })
  );
  return out.filter(Boolean).slice(0, max);
}
__name(rivers, "rivers");
function risk(tide, rain, cur, nowS, rios) {
  const reasons = [];
  let score = 0;
  const add = /* @__PURE__ */ __name((pts, txt) => {
    if (pts) {
      score += pts;
      reasons.push(txt);
    }
  }, "add");
  const tideMax = Math.max(...tide.filter((p) => p.t < nowS + 48 * 3600).map((p) => p.h), -Infinity);
  const waveMax = Math.max(...tide.map((p) => p.wave ?? 0), 0);
  const rain24 = rain.filter((r) => r.t <= nowS + 24 * 3600).reduce((s, r) => s + r.mm, 0);
  const wind = Math.max(cur.wind, cur.gust ?? 0);
  if (isFinite(tideMax)) {
    add(tideMax >= 1.5 ? 3 : tideMax >= 1 ? 2 : tideMax >= 0.6 ? 1 : 0, `Mar\xE9 prevista at\xE9 ${tideMax.toFixed(2)} m acima do n\xEDvel m\xE9dio`);
  }
  add(rain24 >= 80 ? 3 : rain24 >= 40 ? 2 : rain24 >= 15 ? 1 : 0, `Chuva acumulada de ${rain24.toFixed(0)} mm nas pr\xF3ximas 24 h`);
  add(waveMax >= 3 ? 2 : waveMax >= 2 ? 1 : 0, `Ondas de at\xE9 ${waveMax.toFixed(1)} m`);
  add(wind >= 15 ? 1 : 0, `Vento forte (${(wind * 3.6).toFixed(0)} km/h)`);
  add(cur.pressure < 1005 ? 1 : 0, `Press\xE3o baixa (${cur.pressure} hPa)`);
  const coincide = rain.some(
    (r) => r.mm >= 3 && r.t <= nowS + 48 * 3600 && tide.some((p) => p.t > r.t - 3600 && p.t <= r.t && p.h >= 0.6)
  );
  add(coincide ? 2 : 0, "Chuva forte coincide com mar\xE9 alta (drenagem prejudicada)");
  const worst = (rios || []).filter((r) => r.nivel > 0).sort((a, b) => b.nivel - a.nivel)[0];
  if (worst) add(worst.nivel, `Rio ${worst.rio || worst.nome} subindo ${worst.var6h} cm em ~6 h (esta\xE7\xE3o ${worst.nome}, ANA)`);
  const level = score >= 7 ? 3 : score >= 5 ? 2 : score >= 3 ? 1 : 0;
  return { level, score, reasons, rain24, tideMax: isFinite(tideMax) ? tideMax : null };
}
__name(risk, "risk");

// ../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-Jax4Go/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = index_default;

// ../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-Jax4Go/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
