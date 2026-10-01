# Marés e Cheias Litorâneas

> ⚠️ Atividade feita na aula de **CDIA — ProAdis.us**, criada **apenas para testar o deploy**. Não use para decisões reais de segurança.

Repositório: https://github.com/andfranca/Projeto-de-mar-s

- `frontend/index.html` → Cloudflare **Pages** (HTML + Leaflet, sem build)
- `backend/index.js` → Cloudflare **Worker** (`/api/forecast`)

Fontes (todas gratuitas e **sem chave de API**): Open-Meteo (clima e chuva), Open-Meteo Marine (maré e ondas), RainViewer (radar de chuva no mapa) e ANA (rios).

## Rodar local
`npm install`, depois em dois terminais: `npm run dev:api` e `npm run dev:web` (abre em http://localhost:8788).

## Deploy
```bash
npx wrangler login
npm run deploy:api      # anote a URL https://mares-api.<conta>.workers.dev
```
Edite `API` em `frontend/index.html` com essa URL, e em `backend/wrangler.toml` troque `ALLOWED_ORIGIN` pelo domínio do Pages (e rode `deploy:api` de novo). Então:
```bash
npm run deploy:web      # cria o projeto Pages "mares-web"
```

## Rios (ANA)
O Worker consulta o serviço público de telemetria da ANA (`telemetriaws1.ana.gov.br`, sem autenticação): lista estações ativas até 60 km do ponto (RHN + CotaOnline, lista em cache por 24 h) e lê o nível dos últimos 3 dias. A API não traz cotas de alerta, então o status usa o ritmo de subida em ~6 h (≥10 / ≥50 / ≥100 cm) e entra no índice de risco. Se a ANA estiver fora do ar, o painel de rios mostra aviso e o resto continua funcionando.
Obs.: o processamento da lista de estações usa mais CPU que o limite de 10 ms do plano Workers gratuito; se aparecer erro 1102 em produção, use o plano pago do Workers (US$5/mês).

## Observações
- A maré vem de modelo global (~8 km): bom para tendência/horários, mas não substitui as tábuas da Marinha. Não inclui maré meteorológica (ressaca).
- O risco soma pontos: maré, chuva 24 h, ondas, vento, pressão e coincidência chuva + preamar (ver `risk()` em `backend/index.js`). Ajuste os limiares à sua região.
