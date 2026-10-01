var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var UP = { cf: { cacheTtl: 600, cacheEverything: true } };
var TILE_LAYERS = ["precipitation_new", "clouds_new", "wind_new", "pressure_new"];
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
      if (!env.OPENWEATHER_KEY) throw new Error("OPENWEATHER_KEY n\xE3o configurada");
      if (url.pathname === "/api/forecast") {
        const lat = +(+url.searchParams.get("lat")).toFixed(2);
        const lon = +(+url.searchParams.get("lon")).toFixed(2);
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
          return Response.json({ error: "lat/lon inv\xE1lidos" }, { status: 400, headers: cors });
        }
        const data = await forecast(lat, lon, env.OPENWEATHER_KEY);
        return Response.json(data, { headers: { ...cors, "cache-control": "public, max-age=300" } });
      }
      const m = url.pathname.match(/^\/api\/tiles\/(\w+)\/(\d+)\/(\d+)\/(\d+)$/);
      if (m && TILE_LAYERS.includes(m[1])) {
        const [, layer, z, x, y] = m;
        const r = await get(
          `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${env.OPENWEATHER_KEY}`,
          { cf: { cacheTtl: 1800, cacheEverything: true } }
        );
        return new Response(r.body, {
          headers: { ...cors, "content-type": "image/png", "cache-control": "public, max-age=1800" }
        });
      }
      return Response.json({ error: "not found" }, { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors });
    }
  }
};
async function forecast(lat, lon, key) {
  const ow = /* @__PURE__ */ __name((p) => get(`https://api.openweathermap.org/data/2.5/${p}?lat=${lat}&lon=${lon}&units=metric&lang=pt_br&appid=${key}`, UP).then((r) => r.json()), "ow");
  const [cur, fc, sea] = await Promise.all([
    ow("weather"),
    ow("forecast"),
    get(
      `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=sea_level_height_msl,wave_height&timezone=GMT&timeformat=unixtime&forecast_days=3`,
      UP
    ).then((r) => r.json())
  ]);
  const nowS = Math.floor(Date.now() / 1e3);
  const hr = sea.hourly || {};
  const tide = (hr.time || []).map((t, i) => ({ t, h: hr.sea_level_height_msl?.[i], wave: hr.wave_height?.[i] })).filter((p) => p.h != null && p.t >= nowS - 3600);
  const rain = fc.list.map((f) => ({ t: f.dt, mm: f.rain?.["3h"] || 0, pop: f.pop || 0 }));
  const extremes = [];
  for (let i = 1; i < tide.length - 1; i++) {
    const a = tide[i - 1].h, b = tide[i].h, c = tide[i + 1].h;
    if (b > a && b >= c) extremes.push({ t: tide[i].t, h: b, type: "preamar" });
    else if (b < a && b <= c) extremes.push({ t: tide[i].t, h: b, type: "baixa-mar" });
  }
  return {
    location: { lat, lon, name: cur.name || "" },
    now: {
      temp: cur.main.temp,
      feels: cur.main.feels_like,
      humidity: cur.main.humidity,
      pressure: cur.main.pressure,
      wind: cur.wind.speed,
      gust: cur.wind.gust ?? null,
      desc: cur.weather[0].description,
      icon: cur.weather[0].icon
    },
    rain,
    tide,
    extremes,
    risk: risk(tide, rain, cur, nowS)
  };
}
__name(forecast, "forecast");
function risk(tide, rain, cur, nowS) {
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
  const wind = Math.max(cur.wind.speed, cur.wind.gust ?? 0);
  if (isFinite(tideMax)) {
    add(tideMax >= 1.5 ? 3 : tideMax >= 1 ? 2 : tideMax >= 0.6 ? 1 : 0, `Mar\xE9 prevista at\xE9 ${tideMax.toFixed(2)} m acima do n\xEDvel m\xE9dio`);
  }
  add(rain24 >= 80 ? 3 : rain24 >= 40 ? 2 : rain24 >= 15 ? 1 : 0, `Chuva acumulada de ${rain24.toFixed(0)} mm nas pr\xF3ximas 24 h`);
  add(waveMax >= 3 ? 2 : waveMax >= 2 ? 1 : 0, `Ondas de at\xE9 ${waveMax.toFixed(1)} m`);
  add(wind >= 15 ? 1 : 0, `Vento forte (${(wind * 3.6).toFixed(0)} km/h)`);
  add(cur.main.pressure < 1005 ? 1 : 0, `Press\xE3o baixa (${cur.main.pressure} hPa)`);
  const coincide = rain.some(
    (r) => r.mm >= 5 && r.t <= nowS + 48 * 3600 && tide.some((p) => p.t > r.t - 10800 && p.t <= r.t && p.h >= 0.6)
  );
  add(coincide ? 2 : 0, "Chuva forte coincide com mar\xE9 alta (drenagem prejudicada)");
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

// .wrangler/tmp/bundle-UV7IZE/middleware-insertion-facade.js
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

// .wrangler/tmp/bundle-UV7IZE/middleware-loader.entry.ts
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
