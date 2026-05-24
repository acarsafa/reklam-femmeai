# Marpany MCP Server

Asra Pırlanta Meta Ads reklam hesabını Claude üzerinden yönetmek için kurulmuş, kendi sunucunuzda host edilen MCP sunucusu.

**Mimari:**
```
[Claude.ai sohbet] --HTTPS + Bearer auth--> [Bu sunucu] --Graph API + Meta token--> [Meta]
```

## Hızlı Deploy (Railway, ~5 dk)

### 1. Repo'yu GitHub'a yükle

```bash
cd marpany-mcp
git init
git add .
git commit -m "initial commit"
gh repo create marpany-mcp --private --source=. --push
```

(GitHub CLI yoksa: GitHub'da private bir repo oluşturun, sonra `git remote add origin ...` + `git push -u origin main`)

### 2. Railway'e bağla

1. https://railway.app → "New Project" → "Deploy from GitHub repo"
2. `marpany-mcp` repo'sunu seçin
3. Otomatik build başlayacak (Node.js algılanır)

### 3. Environment Variables ekle

Railway projesinde **Variables** sekmesi → şunları girin:

| Değişken | Açıklama | Örnek |
|---|---|---|
| `META_ACCESS_TOKEN` | Marpany BM'den aldığınız System User token (mcp-asra) | `EAAR...` |
| `ASRA_AD_ACCOUNT_ID` | `496361993209176` (sabittir) | `496361993209176` |
| `MCP_SERVER_TOKEN` | Rastgele 32+ karakter secret (alttaki komutla üretin) | (aşağıya bak) |
| `MAX_DAILY_BUDGET_TRY` | Tek kampanyanın max günlük bütçesi (TRY) | `5000` |
| `MAX_BUDGET_INCREASE_PERCENT` | Tek seferde max bütçe artışı (%) | `50` |

**MCP_SERVER_TOKEN üretmek için** (lokal terminalde):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Public URL al

Railway → **Settings → Networking → "Generate Domain"** → bir URL alırsınız:
`marpany-mcp-production-xxxx.up.railway.app`

### 5. Sağlık kontrolü

```bash
curl https://marpany-mcp-production-xxxx.up.railway.app/health
# {"ok":true,"account":"act_496361993209176","tools":9}
```

### 6. claude.ai'ye bağla

1. claude.ai → **Settings → Connectors → Add custom connector**
2. URL: `https://marpany-mcp-production-xxxx.up.railway.app/mcp`
3. Auth: Bearer Token → `MCP_SERVER_TOKEN` değerini yapıştır
4. Save → Yeni bir sohbet başlat → "Asra Pırlanta hesabımı analiz et" gibi prompt verin

## Tool Listesi

**Okuma (her zaman güvenli):**
- `get_account_info` — Hesap durumu, bakiye, harcama
- `list_campaigns` — Kampanyalar
- `list_ad_sets` — Ad set'ler
- `list_ads` — Reklamlar
- `get_insights` — Performans (date_preset, breakdown ile)

**Yazma (guardrail'li):**
- `create_campaign` — Her zaman PAUSED state'te oluşturur
- `update_campaign_status` — ACTIVE ↔ PAUSED
- `update_campaign_budget` — Cap ve artış limiti kontrolü
- `update_ad_set_status` — ACTIVE ↔ PAUSED

## Güvenlik

- Meta token sadece sunucu env'inde, hiçbir log/response'ta görünmez
- Tüm istekler tek bir ad account ID'sine (`ASRA_AD_ACCOUNT_ID`) scoped
- `create_campaign` her zaman PAUSED — yanlışlıkla canlıya çıkamaz
- Bütçe değişiklikleri çift kontrol (absolute cap + %artış)
- MCP endpoint Bearer token ile korumalı

## Token süresi dolarsa

System User token üretilirken "Never expire" seçildiyse, dolmaz. 60 günlük seçildiyse her 60 günde bir Marpany BM'den yeni token üretip Railway env'ini güncellersiniz.

## Lokal geliştirme

```bash
npm install
cp .env.example .env  # ve içini doldur
npm run dev
```

## Tools kapsamını genişletmek

`src/tools.ts` içinde yeni tool tanımı ekleyin, `ALL_TOOLS` array'ine ekleyin. Meta API çağrısı gerekirse `src/meta-client.ts`'e ekleyin.

İlerideki olası eklemeler: creative yönetimi, custom audience oluşturma, dynamic product ads, A/B test kurma.
