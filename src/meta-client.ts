/**
 * Meta Marketing API Client
 * Wraps Graph API v23.0 calls. Scoped to a single ad account for safety.
 */

const GRAPH_API_VERSION = "v23.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface MetaErrorBody {
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export class MetaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: MetaErrorBody,
    public readonly endpoint: string
  ) {
    const msg = body?.error?.message ?? `HTTP ${status} from ${endpoint}`;
    super(`Meta API error: ${msg} (code=${body?.error?.code}, trace=${body?.error?.fbtrace_id})`);
  }
}

export interface MetaClientConfig {
  accessToken: string;
  adAccountId: string; // numeric, without "act_" prefix
}

export class MetaClient {
  private readonly token: string;
  public readonly adAccountId: string;
  public readonly actId: string;

  constructor(config: MetaClientConfig) {
    if (!config.accessToken) throw new Error("META_ACCESS_TOKEN is required");
    if (!config.adAccountId) throw new Error("ASRA_AD_ACCOUNT_ID is required");
    this.token = config.accessToken;
    this.adAccountId = config.adAccountId;
    this.actId = `act_${config.adAccountId}`;
  }

  private async request<T>(
    path: string,
    options: { method?: "GET" | "POST" | "DELETE"; params?: Record<string, string | number | boolean>; body?: Record<string, unknown> } = {}
  ): Promise<T> {
    const method = options.method ?? "GET";
    const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);

    // For GET: params go in query string. For POST: body params except auth.
    if (method === "GET" && options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        url.searchParams.set(k, String(v));
      }
    }
    url.searchParams.set("access_token", this.token);

    const init: RequestInit = { method };
if (method !== "GET" && options.body) {
  // Graph API writes: form-urlencoded; dizi/nesne alanlar JSON string olmalı
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(options.body)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  init.body = form.toString();
}

    const res = await fetch(url.toString(), init);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new MetaApiError(res.status, { error: { message: text, type: "ParseError", code: -1 } }, path);
    }

    if (!res.ok) {
      throw new MetaApiError(res.status, json as MetaErrorBody, path);
    }
    return json as T;
  }

  // ============ READ ============

  async getAccountInfo() {
    return this.request<Record<string, unknown>>(this.actId, {
      params: {
        fields: "id,name,account_status,currency,timezone_name,balance,amount_spent,spend_cap,business_name,business,disable_reason",
      },
    });
  }

  async listCampaigns(limit = 50) {
    return this.request<{ data: unknown[]; paging?: unknown }>(`${this.actId}/campaigns`, {
      params: {
        fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,buying_type,created_time,updated_time",
        limit,
      },
    });
  }

  async listAdSets(campaignId?: string, limit = 50) {
    const path = campaignId ? `${campaignId}/adsets` : `${this.actId}/adsets`;
    return this.request<{ data: unknown[] }>(path, {
      params: {
        fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,bid_amount,optimization_goal,billing_event,targeting,start_time,end_time",
        limit,
      },
    });
  }

  async listAds(adSetId?: string, limit = 50) {
    const path = adSetId ? `${adSetId}/ads` : `${this.actId}/ads`;
    return this.request<{ data: unknown[] }>(path, {
      params: {
        fields: "id,name,adset_id,campaign_id,status,effective_status,creative,created_time",
        limit,
      },
    });
  }

  async getInsights(params: {
    objectId?: string; // campaign/adset/ad ID, defaults to account
    datePreset?: string; // "today", "yesterday", "last_7d", "last_30d", "this_month", "last_month"
    timeRange?: { since: string; until: string }; // YYYY-MM-DD
    level?: "account" | "campaign" | "adset" | "ad";
    breakdowns?: string[]; // e.g. ["age", "gender", "placement"]
    fields?: string[];
  }) {
    const objectId = params.objectId ?? this.actId;
    const defaultFields = [
      "campaign_name",
      "adset_name",
      "ad_name",
      "spend",
      "impressions",
      "clicks",
      "ctr",
      "cpc",
      "cpm",
      "reach",
      "frequency",
      "actions",
      "action_values",
      "purchase_roas",
    ];
    const queryParams: Record<string, string> = {
      fields: (params.fields ?? defaultFields).join(","),
    };
    if (params.datePreset) queryParams.date_preset = params.datePreset;
    if (params.timeRange) queryParams.time_range = JSON.stringify(params.timeRange);
    if (params.level) queryParams.level = params.level;
    if (params.breakdowns && params.breakdowns.length > 0) {
      queryParams.breakdowns = params.breakdowns.join(",");
    }
    return this.request<{ data: unknown[]; paging?: unknown }>(`${objectId}/insights`, {
      params: queryParams,
    });
  }

  // ============ WRITE ============

  async createCampaign(params: {
    name: string;
    objective: string;
    dailyBudgetCents?: number;
    lifetimeBudgetCents?: number;
    specialAdCategories?: string[];
    bidStrategy?: string;
  }) {
    const body: Record<string, unknown> = {
      name: params.name,
      objective: params.objective,
      status: "PAUSED", // ALWAYS paused on creation - safety
      special_ad_categories: params.specialAdCategories ?? [],
    };
    if (params.dailyBudgetCents) body.daily_budget = params.dailyBudgetCents;
    if (params.lifetimeBudgetCents) body.lifetime_budget = params.lifetimeBudgetCents;
    if (params.bidStrategy) body.bid_strategy = params.bidStrategy;
    return this.request<{ id: string }>(`${this.actId}/campaigns`, { method: "POST", body });
  }

  async updateCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED") {
    return this.request<{ success: boolean }>(campaignId, { method: "POST", body: { status } });
  }

  async updateCampaignBudget(campaignId: string, params: { dailyBudgetCents?: number; lifetimeBudgetCents?: number }) {
    const body: Record<string, unknown> = {};
    if (params.dailyBudgetCents !== undefined) body.daily_budget = params.dailyBudgetCents;
    if (params.lifetimeBudgetCents !== undefined) body.lifetime_budget = params.lifetimeBudgetCents;
    if (Object.keys(body).length === 0) throw new Error("At least one budget field required");
    return this.request<{ success: boolean }>(campaignId, { method: "POST", body });
  }

  async updateAdSetStatus(adSetId: string, status: "ACTIVE" | "PAUSED") {
    return this.request<{ success: boolean }>(adSetId, { method: "POST", body: { status } });
  }

  // ============ PAGES ============

  async listPages() {
    return this.request<{ data: unknown[] }>(`${this.actId}/promote_pages`, {
      params: { fields: "id,name,access_token,picture,link", limit: 50 },
    });
  }

  // ============ IMAGES ============

  /**
   * Upload an image (base64-encoded) to the ad account's image library.
   * Returns hash that can be used in creatives.
   */
  async uploadImage(base64Data: string, filename = "image.jpg"): Promise<{ images: Record<string, { hash: string; url: string }> }> {
    // Meta accepts images via multipart/form-data with the bytes field
    const url = new URL(`${GRAPH_BASE}/${this.actId}/adimages`);
    url.searchParams.set("access_token", this.token);

    // Convert base64 to binary
    const buffer = Buffer.from(base64Data, "base64");
    const blob = new Blob([buffer]);
    const formData = new FormData();
    formData.append("filename", blob, filename);

    const res = await fetch(url.toString(), { method: "POST", body: formData });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new MetaApiError(res.status, { error: { message: text, type: "ParseError", code: -1 } }, "adimages");
    }
    if (!res.ok) {
      throw new MetaApiError(res.status, json as MetaErrorBody, "adimages");
    }
    return json as { images: Record<string, { hash: string; url: string }> };
  }

  // ============ CREATIVES ============

  async listCreatives(limit = 50) {
    return this.request<{ data: unknown[] }>(`${this.actId}/adcreatives`, {
      params: {
        fields: "id,name,title,body,image_url,thumbnail_url,object_type,call_to_action_type,effective_object_story_id",
        limit,
      },
    });
  }

  async createCreativeLinkImage(params: {
    name: string;
    pageId: string;
    imageHash: string;
    link: string;
    message: string; // primary text
    headline?: string; // ad title
    description?: string; // link description
    callToActionType?: string; // e.g. "SHOP_NOW", "LEARN_MORE"
    instagramActorId?: string;
  }) {
    const objectStorySpec: Record<string, unknown> = {
      page_id: params.pageId,
      link_data: {
        image_hash: params.imageHash,
        link: params.link,
        message: params.message,
        name: params.headline,
        description: params.description,
        call_to_action: params.callToActionType
          ? { type: params.callToActionType, value: { link: params.link } }
          : undefined,
      },
    };
    if (params.instagramActorId) objectStorySpec.instagram_actor_id = params.instagramActorId;

    return this.request<{ id: string }>(`${this.actId}/adcreatives`, {
      method: "POST",
      body: {
        name: params.name,
        object_story_spec: objectStorySpec,
      },
    });
  }

  // ============ AD SETS (CREATE/UPDATE) ============

  async createAdSet(params: {
    name: string;
    campaignId: string;
    dailyBudgetCents?: number;
    lifetimeBudgetCents?: number;
    optimizationGoal: string;
    billingEvent?: string;
    bidStrategy?: string;
    bidAmountCents?: number;
    targeting: Record<string, unknown>;
    startTime?: string;
    endTime?: string;
    promotedObject?: Record<string, unknown>;
  }) {
    const body: Record<string, unknown> = {
      name: params.name,
      campaign_id: params.campaignId,
      status: "PAUSED",
      optimization_goal: params.optimizationGoal,
      billing_event: params.billingEvent ?? "IMPRESSIONS",
      targeting: params.targeting,
    };
    if (params.dailyBudgetCents) body.daily_budget = params.dailyBudgetCents;
    if (params.lifetimeBudgetCents) body.lifetime_budget = params.lifetimeBudgetCents;
    if (params.bidStrategy) body.bid_strategy = params.bidStrategy;
    if (params.bidAmountCents) body.bid_amount = params.bidAmountCents;
    if (params.startTime) body.start_time = params.startTime;
    if (params.endTime) body.end_time = params.endTime;
    if (params.promotedObject) body.promoted_object = params.promotedObject;
    return this.request<{ id: string }>(`${this.actId}/adsets`, { method: "POST", body });
  }

  async updateAdSet(adSetId: string, params: {
    name?: string;
    dailyBudgetCents?: number;
    lifetimeBudgetCents?: number;
    targeting?: Record<string, unknown>;
    bidAmountCents?: number;
    bidStrategy?: string;
  }) {
    const body: Record<string, unknown> = {};
    if (params.name) body.name = params.name;
    if (params.dailyBudgetCents !== undefined) body.daily_budget = params.dailyBudgetCents;
    if (params.lifetimeBudgetCents !== undefined) body.lifetime_budget = params.lifetimeBudgetCents;
    if (params.targeting) body.targeting = params.targeting;
    if (params.bidAmountCents !== undefined) body.bid_amount = params.bidAmountCents;
    if (params.bidStrategy) body.bid_strategy = params.bidStrategy;
    if (Object.keys(body).length === 0) throw new Error("At least one field to update is required");
    return this.request<{ success: boolean }>(adSetId, { method: "POST", body });
  }

  // ============ ADS (CREATE/UPDATE) ============

  async createAd(params: {
    name: string;
    adSetId: string;
    creativeId: string;
  }) {
    return this.request<{ id: string }>(`${this.actId}/ads`, {
      method: "POST",
      body: {
        name: params.name,
        adset_id: params.adSetId,
        creative: { creative_id: params.creativeId },
        status: "PAUSED", // always paused for safety
      },
    });
  }

  async updateAdStatus(adId: string, status: "ACTIVE" | "PAUSED") {
    return this.request<{ success: boolean }>(adId, { method: "POST", body: { status } });
  }

  // ============ CUSTOM AUDIENCES ============

  async listCustomAudiences(limit = 50) {
    return this.request<{ data: unknown[] }>(`${this.actId}/customaudiences`, {
      params: {
        fields: "id,name,description,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,time_created",
        limit,
      },
    });
  }

  // ============ CATALOGS & PRODUCT SETS ============

  async listCatalogs() {
    // Catalogs accessible from this ad account
    return this.request<{ data?: unknown[]; product_catalogs?: { data: unknown[] } } | { data: unknown[] }>(this.actId, {
      params: { fields: "product_catalogs{id,name,product_count,vertical}" },
    });
  }

  async listProductSets(catalogId: string, limit = 50) {
    return this.request<{ data: unknown[] }>(`${catalogId}/product_sets`, {
      params: {
        fields: "id,name,product_count,filter",
        limit,
      },
    });
  }

  // ============ TARGETING SEARCH ============

  async searchTargetingInterests(query: string, limit = 25) {
    return this.request<{ data: unknown[] }>("search", {
      params: {
        type: "adinterest",
        q: query,
        limit,
      },
    });
  }
}
