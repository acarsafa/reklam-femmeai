/**
 * MCP Tool definitions and handlers.
 * Each tool has: name, description, JSON schema for input, and a handler.
 */

import { z } from "zod";
import type { MetaClient } from "./meta-client.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, client: MetaClient, guardrails: Guardrails) => Promise<unknown>;
}

export interface Guardrails {
  maxDailyBudgetCents: number; // TRY in kuruş (1 TL = 100 kuruş, ama Meta minor unit = 1/100, so cents)
  maxBudgetIncreasePercent: number;
}

// ============ READ TOOLS ============

const getAccountInfoTool: ToolDefinition = {
  name: "get_account_info",
  description:
    "Asra Pırlanta reklam hesabının özet bilgilerini getirir: bakiye, harcama, durumu, para birimi, zaman dilimi. Hesap sağlığı kontrolü için ilk başvurulacak araç.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, client) => await client.getAccountInfo(),
};

const listCampaignsTool: ToolDefinition = {
  name: "list_campaigns",
  description:
    "Hesaptaki tüm kampanyaları listeler. Her kampanyanın ID, ad, objective, status, bütçe bilgilerini döndürür.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Maksimum kampanya sayısı (varsayılan: 50)", default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z.object({ limit: z.number().optional() }).parse(args);
    return await client.listCampaigns(parsed.limit);
  },
};

const listAdSetsTool: ToolDefinition = {
  name: "list_ad_sets",
  description:
    "Bir kampanyanın ad set'lerini listeler. campaign_id verilmezse tüm hesabın ad set'leri döner.",
  inputSchema: {
    type: "object",
    properties: {
      campaign_id: { type: "string", description: "Kampanya ID (opsiyonel)" },
      limit: { type: "number", default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z.object({ campaign_id: z.string().optional(), limit: z.number().optional() }).parse(args);
    return await client.listAdSets(parsed.campaign_id, parsed.limit);
  },
};

const listAdsTool: ToolDefinition = {
  name: "list_ads",
  description: "Bir ad set'in reklamlarını listeler. adset_id verilmezse tüm hesabın reklamları döner.",
  inputSchema: {
    type: "object",
    properties: {
      adset_id: { type: "string", description: "Ad set ID (opsiyonel)" },
      limit: { type: "number", default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z.object({ adset_id: z.string().optional(), limit: z.number().optional() }).parse(args);
    return await client.listAds(parsed.adset_id, parsed.limit);
  },
};

const getInsightsTool: ToolDefinition = {
  name: "get_insights",
  description:
    "Performans verisi çeker (harcama, impression, click, CTR, CPC, CPM, ROAS, dönüşümler). object_id verilirse o objenin (campaign/adset/ad), yoksa tüm hesabın verisi.",
  inputSchema: {
    type: "object",
    properties: {
      object_id: { type: "string", description: "Campaign/AdSet/Ad ID (opsiyonel, yoksa hesap geneli)" },
      date_preset: {
        type: "string",
        enum: ["today", "yesterday", "last_7d", "last_14d", "last_30d", "last_90d", "this_month", "last_month", "this_quarter", "lifetime"],
        description: "Tarih aralığı preseti",
      },
      time_range_since: { type: "string", description: "YYYY-MM-DD formatında başlangıç (custom range)" },
      time_range_until: { type: "string", description: "YYYY-MM-DD formatında bitiş (custom range)" },
      level: {
        type: "string",
        enum: ["account", "campaign", "adset", "ad"],
        description: "Hangi seviyede kırılım gerek",
      },
      breakdowns: {
        type: "array",
        items: { type: "string" },
        description: "Breakdown'lar (örn. age, gender, placement, country, device_platform)",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z
      .object({
        object_id: z.string().optional(),
        date_preset: z.string().optional(),
        time_range_since: z.string().optional(),
        time_range_until: z.string().optional(),
        level: z.enum(["account", "campaign", "adset", "ad"]).optional(),
        breakdowns: z.array(z.string()).optional(),
      })
      .parse(args);

    const timeRange =
      parsed.time_range_since && parsed.time_range_until
        ? { since: parsed.time_range_since, until: parsed.time_range_until }
        : undefined;

    return await client.getInsights({
      objectId: parsed.object_id,
      datePreset: parsed.date_preset,
      timeRange,
      level: parsed.level,
      breakdowns: parsed.breakdowns,
    });
  },
};

// ============ WRITE TOOLS (safety-bounded) ============

const createCampaignTool: ToolDefinition = {
  name: "create_campaign",
  description:
    "Yeni kampanya oluşturur. GÜVENLİK: kampanya her zaman PAUSED state'te oluşturulur — kullanıcı Ads Manager'da gözden geçirip aktif etmeli. Bütçe limiti kontrolü yapılır.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Kampanya adı" },
      objective: {
        type: "string",
        enum: ["OUTCOME_SALES", "OUTCOME_TRAFFIC", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_APP_PROMOTION"],
        description: "Kampanya hedefi (yeni objective sistemi)",
      },
      daily_budget_try: {
        type: "number",
        description: "Günlük bütçe (TRY cinsinden, örn. 100 = 100 TL)",
      },
      lifetime_budget_try: {
        type: "number",
        description: "Toplam bütçe (TRY cinsinden, daily_budget yerine bu da kullanılabilir)",
      },
      special_ad_categories: {
        type: "array",
        items: { type: "string", enum: ["NONE", "HOUSING", "EMPLOYMENT", "CREDIT", "ISSUES_ELECTIONS_POLITICS"] },
        description: "Özel reklam kategorisi (Asra Pırlanta için genelde boş array veya [NONE])",
      },
    },
    required: ["name", "objective"],
    additionalProperties: false,
  },
  handler: async (args, client, guardrails) => {
    const parsed = z
      .object({
        name: z.string().min(1),
        objective: z.string(),
        daily_budget_try: z.number().positive().optional(),
        lifetime_budget_try: z.number().positive().optional(),
        special_ad_categories: z.array(z.string()).optional(),
      })
      .parse(args);

    // Convert TRY to cents (Meta uses minor unit; for TRY 1 TL = 100 kuruş)
    const dailyBudgetCents = parsed.daily_budget_try ? Math.round(parsed.daily_budget_try * 100) : undefined;
    const lifetimeBudgetCents = parsed.lifetime_budget_try ? Math.round(parsed.lifetime_budget_try * 100) : undefined;

    // Guardrail: max daily budget
    if (dailyBudgetCents && dailyBudgetCents > guardrails.maxDailyBudgetCents) {
      throw new Error(
        `Günlük bütçe limiti aşıldı. İstenen: ${parsed.daily_budget_try} TL, Limit: ${guardrails.maxDailyBudgetCents / 100} TL. ` +
          `Daha yüksek bütçe için MAX_DAILY_BUDGET_TRY env değişkenini güncelleyin.`
      );
    }

    return await client.createCampaign({
      name: parsed.name,
      objective: parsed.objective,
      dailyBudgetCents,
      lifetimeBudgetCents,
      specialAdCategories: parsed.special_ad_categories,
    });
  },
};

const updateCampaignStatusTool: ToolDefinition = {
  name: "update_campaign_status",
  description: "Bir kampanyayı aktif eder veya duraklatır.",
  inputSchema: {
    type: "object",
    properties: {
      campaign_id: { type: "string" },
      status: { type: "string", enum: ["ACTIVE", "PAUSED"] },
    },
    required: ["campaign_id", "status"],
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z
      .object({
        campaign_id: z.string(),
        status: z.enum(["ACTIVE", "PAUSED"]),
      })
      .parse(args);
    return await client.updateCampaignStatus(parsed.campaign_id, parsed.status);
  },
};

const updateCampaignBudgetTool: ToolDefinition = {
  name: "update_campaign_budget",
  description:
    "Bir kampanyanın günlük veya toplam bütçesini değiştirir. GÜVENLİK: mevcut bütçeye göre %X üstü artış engellenir (env'de MAX_BUDGET_INCREASE_PERCENT).",
  inputSchema: {
    type: "object",
    properties: {
      campaign_id: { type: "string" },
      daily_budget_try: { type: "number", description: "Yeni günlük bütçe (TRY)" },
      lifetime_budget_try: { type: "number", description: "Yeni toplam bütçe (TRY)" },
    },
    required: ["campaign_id"],
    additionalProperties: false,
  },
  handler: async (args, client, guardrails) => {
    const parsed = z
      .object({
        campaign_id: z.string(),
        daily_budget_try: z.number().positive().optional(),
        lifetime_budget_try: z.number().positive().optional(),
      })
      .parse(args);

    if (!parsed.daily_budget_try && !parsed.lifetime_budget_try) {
      throw new Error("En az bir bütçe alanı girilmeli (daily_budget_try veya lifetime_budget_try)");
    }

    // Read current campaign to compare
    const campaigns = (await client.listCampaigns(200)) as { data: Array<{ id: string; daily_budget?: string; lifetime_budget?: string; name: string }> };
    const current = campaigns.data.find((c) => c.id === parsed.campaign_id);
    if (!current) throw new Error(`Kampanya bulunamadı: ${parsed.campaign_id}`);

    // Check max increase % guardrail
    if (parsed.daily_budget_try && current.daily_budget) {
      const currentTry = Number(current.daily_budget) / 100;
      const increasePercent = ((parsed.daily_budget_try - currentTry) / currentTry) * 100;
      if (increasePercent > guardrails.maxBudgetIncreasePercent) {
        throw new Error(
          `Bütçe artış limiti aşıldı. Mevcut: ${currentTry} TL → İstenen: ${parsed.daily_budget_try} TL (%${increasePercent.toFixed(1)} artış). ` +
            `Limit: %${guardrails.maxBudgetIncreasePercent}. Birden fazla küçük adımla yapın veya MAX_BUDGET_INCREASE_PERCENT'i güncelleyin.`
        );
      }
    }

    // Check absolute daily budget cap
    if (parsed.daily_budget_try && parsed.daily_budget_try * 100 > guardrails.maxDailyBudgetCents) {
      throw new Error(
        `Günlük bütçe absolute limiti aşıldı. İstenen: ${parsed.daily_budget_try} TL, Limit: ${guardrails.maxDailyBudgetCents / 100} TL`
      );
    }

    return await client.updateCampaignBudget(parsed.campaign_id, {
      dailyBudgetCents: parsed.daily_budget_try ? Math.round(parsed.daily_budget_try * 100) : undefined,
      lifetimeBudgetCents: parsed.lifetime_budget_try ? Math.round(parsed.lifetime_budget_try * 100) : undefined,
    });
  },
};

const updateAdSetStatusTool: ToolDefinition = {
  name: "update_ad_set_status",
  description: "Bir ad set'i aktif eder veya duraklatır.",
  inputSchema: {
    type: "object",
    properties: {
      ad_set_id: { type: "string" },
      status: { type: "string", enum: ["ACTIVE", "PAUSED"] },
    },
    required: ["ad_set_id", "status"],
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z
      .object({
        ad_set_id: z.string(),
        status: z.enum(["ACTIVE", "PAUSED"]),
      })
      .parse(args);
    return await client.updateAdSetStatus(parsed.ad_set_id, parsed.status);
  },
};

// ============ PAGES & IMAGES & CREATIVES ============

const listPagesTool: ToolDefinition = {
  name: "list_pages",
  description:
    "Bu reklam hesabı altında reklam çıkabileceğin Facebook sayfalarını listeler. Reklam oluştururken page_id gerekir; bu listeden seçilir. Asra Pırlanta için tek sayfa olmalı.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, client) => await client.listPages(),
};

const uploadImageTool: ToolDefinition = {
  name: "upload_image",
  description:
    "Bir görseli Meta'nın reklam görsel kütüphanesine yükler ve hash döndürür. Hash, creative oluştururken kullanılır. Görsel base64 string olarak verilmeli. Kullanıcı görsel yüklediğinde önce bunu kullan, hash'i al, sonra create_creative_link'te kullan.",
  inputSchema: {
    type: "object",
    properties: {
      image_base64: { type: "string", description: "Görselin base64-encoded içeriği (data URI prefix'i olmadan)" },
      filename: { type: "string", description: "Dosya adı (örn. 'asra-yuzuk.jpg')", default: "image.jpg" },
    },
    required: ["image_base64"],
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z
      .object({
        image_base64: z.string().min(100),
        filename: z.string().optional(),
      })
      .parse(args);
    const result = await client.uploadImage(parsed.image_base64, parsed.filename);
    // Simplify response - return the hash directly
    const firstKey = Object.keys(result.images)[0];
    const img = result.images[firstKey];
    return { hash: img.hash, url: img.url, filename: firstKey };
  },
};

const listCreativesTool: ToolDefinition = {
  name: "list_creatives",
  description: "Hesaptaki mevcut ad creative'leri listeler. Yeni reklam yaparken aynı creative'i tekrar kullanmak için.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "number", default: 50 } },
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z.object({ limit: z.number().optional() }).parse(args);
    return await client.listCreatives(parsed.limit);
  },
};

const createCreativeLinkTool: ToolDefinition = {
  name: "create_creative_link",
  description:
    "Tek görsel + link reklamı için creative oluşturur. Önce upload_image ile görsel yükleyip hash al, sonra burada kullan. Ürün sayfasına yönlendiren reklamlarda ideal. Asra için: ürün linki + yüksek kaliteli mücevher görseli + 'Hemen İncele' CTA gibi.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Creative iç adı (örn. 'asra-yuzuk-001-creative')" },
      page_id: { type: "string", description: "Facebook sayfa ID (list_pages'ten al)" },
      image_hash: { type: "string", description: "upload_image'den dönen hash" },
      link: { type: "string", description: "Tıklandığında gidilecek URL (örn. ürün sayfası)" },
      message: { type: "string", description: "Reklamın ana metni (post text)" },
      headline: { type: "string", description: "Reklam başlığı (görselin altında büyük yazı, max ~40 karakter)" },
      description: { type: "string", description: "Link açıklaması (başlığın altında küçük yazı)" },
      call_to_action_type: {
        type: "string",
        enum: ["SHOP_NOW", "LEARN_MORE", "BUY_NOW", "GET_OFFER", "SIGN_UP", "SUBSCRIBE", "CONTACT_US", "ORDER_NOW", "BOOK_TRAVEL", "DOWNLOAD"],
        description: "Buton metni (Asra için en sık: SHOP_NOW veya LEARN_MORE)",
      },
      instagram_actor_id: { type: "string", description: "Instagram hesap ID (opsiyonel, IG'de de yayınlamak istersen)" },
    },
    required: ["name", "page_id", "image_hash", "link", "message"],
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z
      .object({
        name: z.string().min(1),
        page_id: z.string(),
        image_hash: z.string(),
        link: z.string().url(),
        message: z.string().min(1),
        headline: z.string().optional(),
        description: z.string().optional(),
        call_to_action_type: z.string().optional(),
        instagram_actor_id: z.string().optional(),
      })
      .parse(args);
    return await client.createCreativeLinkImage({
      name: parsed.name,
      pageId: parsed.page_id,
      imageHash: parsed.image_hash,
      link: parsed.link,
      message: parsed.message,
      headline: parsed.headline,
      description: parsed.description,
      callToActionType: parsed.call_to_action_type,
      instagramActorId: parsed.instagram_actor_id,
    });
  },
};

// ============ AD SET CREATION ============

const createAdSetTool: ToolDefinition = {
  name: "create_ad_set",
  description:
    "Bir kampanyaya yeni ad set ekler. Targeting (kim görecek), optimizasyon hedefi, bütçe içerir. GÜVENLİK: her zaman PAUSED state'te. Bütçe limiti kontrolü yapılır. Targeting JSON formatı için Meta dökümanlarına bakılabilir; basit bir örnek: {geo_locations: {countries: ['TR']}, age_min: 25, age_max: 55, genders: [2]}.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Ad set adı" },
      campaign_id: { type: "string", description: "Bağlanacağı kampanyanın ID'si" },
      daily_budget_try: { type: "number", description: "Günlük bütçe (TRY)" },
      lifetime_budget_try: { type: "number", description: "Toplam bütçe (TRY) — daily yerine bu kullanılabilir" },
      optimization_goal: {
        type: "string",
        enum: ["REACH", "IMPRESSIONS", "LINK_CLICKS", "OFFSITE_CONVERSIONS", "LANDING_PAGE_VIEWS", "POST_ENGAGEMENT", "VALUE", "THRUPLAY", "QUALITY_LEAD"],
        description: "Optimizasyon hedefi (kampanya objective'iyle uyumlu olmalı). Asra için tipik: OFFSITE_CONVERSIONS (satış) veya LANDING_PAGE_VIEWS (trafik).",
      },
      billing_event: {
        type: "string",
        enum: ["IMPRESSIONS", "LINK_CLICKS", "POST_ENGAGEMENT", "THRUPLAY"],
        description: "Faturalama olayı (default: IMPRESSIONS)",
      },
      bid_strategy: {
        type: "string",
        enum: ["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP", "LOWEST_COST_WITH_MIN_ROAS"],
        description: "Teklif stratejisi. Default: LOWEST_COST_WITHOUT_CAP",
      },
      bid_amount_try: { type: "number", description: "Bid cap stratejisi kullanılıyorsa max teklif (TRY)" },
      targeting: {
        type: "object",
        description:
          "Targeting JSON. Örnek: {\"geo_locations\":{\"countries\":[\"TR\"]},\"age_min\":25,\"age_max\":55,\"genders\":[2],\"interests\":[{\"id\":\"6003020834693\",\"name\":\"Jewellery\"}]}. genders: 1=erkek, 2=kadın. Interests için önce search_interests kullan, ID al.",
      },
      start_time: { type: "string", description: "ISO 8601 datetime, opsiyonel" },
      end_time: { type: "string", description: "ISO 8601 datetime, opsiyonel (lifetime_budget kullanılıyorsa zorunlu)" },
      promoted_object: {
        type: "object",
        description: "Conversion kampanyalarında: {\"pixel_id\":\"...\",\"custom_event_type\":\"PURCHASE\"} gibi",
      },
    },
    required: ["name", "campaign_id", "optimization_goal", "targeting"],
    additionalProperties: false,
  },
  handler: async (args, client, guardrails) => {
    const parsed = z
      .object({
        name: z.string().min(1),
        campaign_id: z.string(),
        daily_budget_try: z.number().positive().optional(),
        lifetime_budget_try: z.number().positive().optional(),
        optimization_goal: z.string(),
        billing_event: z.string().optional(),
        bid_strategy: z.string().optional(),
        bid_amount_try: z.number().positive().optional(),
        targeting: z.record(z.unknown()),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        promoted_object: z.record(z.unknown()).optional(),
      })
      .parse(args);

    const dailyBudgetCents = parsed.daily_budget_try ? Math.round(parsed.daily_budget_try * 100) : undefined;
    if (dailyBudgetCents && dailyBudgetCents > guardrails.maxDailyBudgetCents) {
      throw new Error(
        `Ad set günlük bütçe limiti aşıldı. İstenen: ${parsed.daily_budget_try} TL, Limit: ${guardrails.maxDailyBudgetCents / 100} TL`
      );
    }
    return await client.createAdSet({
      name: parsed.name,
      campaignId: parsed.campaign_id,
      dailyBudgetCents,
      lifetimeBudgetCents: parsed.lifetime_budget_try ? Math.round(parsed.lifetime_budget_try * 100) : undefined,
      optimizationGoal: parsed.optimization_goal,
      billingEvent: parsed.billing_event,
      bidStrategy: parsed.bid_strategy,
      bidAmountCents: parsed.bid_amount_try ? Math.round(parsed.bid_amount_try * 100) : undefined,
      targeting: parsed.targeting,
      startTime: parsed.start_time,
      endTime: parsed.end_time,
      promotedObject: parsed.promoted_object,
    });
  },
};

const updateAdSetTool: ToolDefinition = {
  name: "update_ad_set",
  description: "Bir ad set'in adını, bütçesini, targeting'ini veya teklifini günceller. Bütçe değişikliklerinde guardrail uygulanır.",
  inputSchema: {
    type: "object",
    properties: {
      ad_set_id: { type: "string" },
      name: { type: "string" },
      daily_budget_try: { type: "number" },
      lifetime_budget_try: { type: "number" },
      targeting: { type: "object" },
      bid_amount_try: { type: "number" },
      bid_strategy: { type: "string" },
    },
    required: ["ad_set_id"],
    additionalProperties: false,
  },
  handler: async (args, client, guardrails) => {
    const parsed = z
      .object({
        ad_set_id: z.string(),
        name: z.string().optional(),
        daily_budget_try: z.number().positive().optional(),
        lifetime_budget_try: z.number().positive().optional(),
        targeting: z.record(z.unknown()).optional(),
        bid_amount_try: z.number().positive().optional(),
        bid_strategy: z.string().optional(),
      })
      .parse(args);

    if (parsed.daily_budget_try && parsed.daily_budget_try * 100 > guardrails.maxDailyBudgetCents) {
      throw new Error(
        `Günlük bütçe absolute limit aşıldı. İstenen: ${parsed.daily_budget_try} TL, Limit: ${guardrails.maxDailyBudgetCents / 100} TL`
      );
    }
    return await client.updateAdSet(parsed.ad_set_id, {
      name: parsed.name,
      dailyBudgetCents: parsed.daily_budget_try ? Math.round(parsed.daily_budget_try * 100) : undefined,
      lifetimeBudgetCents: parsed.lifetime_budget_try ? Math.round(parsed.lifetime_budget_try * 100) : undefined,
      targeting: parsed.targeting,
      bidAmountCents: parsed.bid_amount_try ? Math.round(parsed.bid_amount_try * 100) : undefined,
      bidStrategy: parsed.bid_strategy,
    });
  },
};

// ============ AD CREATE/UPDATE ============

const createAdTool: ToolDefinition = {
  name: "create_ad",
  description:
    "Bir ad set'e yeni reklam ekler. Ad set + creative'i birleştirir. GÜVENLİK: her zaman PAUSED state'te oluşturulur. Sıra: create_campaign → create_ad_set → upload_image → create_creative_link → create_ad → (kullanıcı gözden geçirip aktif etsin).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Reklam adı" },
      ad_set_id: { type: "string", description: "Bağlanacağı ad set'in ID'si" },
      creative_id: { type: "string", description: "Bağlanacağı creative'in ID'si (create_creative_link'ten dönen)" },
    },
    required: ["name", "ad_set_id", "creative_id"],
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z
      .object({
        name: z.string().min(1),
        ad_set_id: z.string(),
        creative_id: z.string(),
      })
      .parse(args);
    return await client.createAd({
      name: parsed.name,
      adSetId: parsed.ad_set_id,
      creativeId: parsed.creative_id,
    });
  },
};

const updateAdStatusTool: ToolDefinition = {
  name: "update_ad_status",
  description: "Bir reklamı aktif eder veya duraklatır.",
  inputSchema: {
    type: "object",
    properties: {
      ad_id: { type: "string" },
      status: { type: "string", enum: ["ACTIVE", "PAUSED"] },
    },
    required: ["ad_id", "status"],
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z.object({ ad_id: z.string(), status: z.enum(["ACTIVE", "PAUSED"]) }).parse(args);
    return await client.updateAdStatus(parsed.ad_id, parsed.status);
  },
};

// ============ AUDIENCES, CATALOGS, TARGETING ============

const listCustomAudiencesTool: ToolDefinition = {
  name: "list_custom_audiences",
  description: "Hesaptaki custom audience'ları listeler (retargeting, lookalike, site ziyaretçileri vb.). Ad set targeting'inde custom_audiences alanında ID'leri kullanılır.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "number", default: 50 } },
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z.object({ limit: z.number().optional() }).parse(args);
    return await client.listCustomAudiences(parsed.limit);
  },
};

const listCatalogsTool: ToolDefinition = {
  name: "list_catalogs",
  description:
    "Hesabın erişebildiği ürün kataloglarını listeler. Asra Pırlanta'nın 'Yeni Tasarım Katalog' veya 'Asra_Katalog_Ürünler' gibi katalogları görünür. Catalog/DPA reklamları için catalog_id gerekir.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, client) => await client.listCatalogs(),
};

const listProductSetsTool: ToolDefinition = {
  name: "list_product_sets",
  description: "Bir katalogdaki ürün setlerini listeler (örn. 'yüzükler', 'kolyeler', 'indirimli ürünler'). Catalog/DPA reklamlarında ad set'e bağlanır.",
  inputSchema: {
    type: "object",
    properties: {
      catalog_id: { type: "string" },
      limit: { type: "number", default: 50 },
    },
    required: ["catalog_id"],
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z.object({ catalog_id: z.string(), limit: z.number().optional() }).parse(args);
    return await client.listProductSets(parsed.catalog_id, parsed.limit);
  },
};

const searchInterestsTool: ToolDefinition = {
  name: "search_interests",
  description:
    "Targeting için ilgi alanı/interest araması yapar. Sonuçtaki ID'leri ad set targeting'inde interests alanında kullanırsın. Örnek query: 'jewelry', 'wedding rings', 'luxury fashion'. Asra için yararlı: 'engagement ring', 'fine jewelry', 'gold', 'diamond'.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "İlgi alanı araması (İngilizce daha iyi sonuç verir)" },
      limit: { type: "number", default: 25 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (args, client) => {
    const parsed = z.object({ query: z.string().min(1), limit: z.number().optional() }).parse(args);
    return await client.searchTargetingInterests(parsed.query, parsed.limit);
  },
};

export const ALL_TOOLS: ToolDefinition[] = [
  // Read - basic
  getAccountInfoTool,
  listCampaignsTool,
  listAdSetsTool,
  listAdsTool,
  getInsightsTool,
  // Write - campaign
  createCampaignTool,
  updateCampaignStatusTool,
  updateCampaignBudgetTool,
  updateAdSetStatusTool,
  // New: pages, images, creatives
  listPagesTool,
  uploadImageTool,
  listCreativesTool,
  createCreativeLinkTool,
  // New: ad sets
  createAdSetTool,
  updateAdSetTool,
  // New: ads
  createAdTool,
  updateAdStatusTool,
  // New: audiences, catalogs, targeting
  listCustomAudiencesTool,
  listCatalogsTool,
  listProductSetsTool,
  searchInterestsTool,
];
