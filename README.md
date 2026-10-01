# Marés e Cheias Litorâneas

- `frontend/index.html` → Cloudflare **Pages** (HTML + Leaflet, sem build)
- `backend/index.js` → Cloudflare **Worker** (`/api/forecast`, `/api/tiles/...`)

Fontes (gratuitas): OpenWeather (clima, chuva, camadas do mapa; chave grátis) e Open-Meteo Marine (maré, sem chave).

## Rodar local
1. Chave grátis em https://openweathermap.org/api
2. `backend/.dev.vars`: `OPENWEATHER_KEY=sua_chave`
3. `npm install`, depois em dois terminais: `npm run dev:api` e `npm run dev:web`

## Deploy
```bash
npx wrangler login
npx wrangler secret put OPENWEATHER_KEY -c backend/wrangler.toml
npm run deploy:api      # anote a URL https://mares-api.<conta>.workers.dev
```
Edite `API` em `frontend/index.html` com essa URL, e em `backend/wrangler.toml` troque `ALLOWED_ORIGIN` pelo domínio do Pages (e rode `deploy:api` de novo). Então:
```bash
npm run deploy:web      # cria o projeto Pages "mares-web"
```

## Observações
- A maré vem de modelo global (~8 km): bom para tendência/horários, mas não substitui as tábuas da Marinha. Não inclui maré meteorológica (ressaca).
- O risco soma pontos: maré, chuva 24 h, ondas, vento, pressão e coincidência chuva + preamar (ver `risk()` em `backend/index.js`). Ajuste os limiares à sua região.
