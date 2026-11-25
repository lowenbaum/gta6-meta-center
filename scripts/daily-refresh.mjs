// scripts/daily-refresh.mjs
// Beat Six Balanced Tier List & Canonical Meta Aggregator
// Free-Tier Safe: max 8 paced Gemini calls/day ($0.00 on Google AI Studio Free Tier)
// Strictly updates data.json only; never touches index.html.

import fs from "node:fs";
import path from "node:path";

const DATA_PATH = path.resolve(process.cwd(), "data.json");
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim().replace(/^["']|["']$/g, "");
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || "").trim().replace(/^["']|["']$/g, "");

const FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite"
];

let ACTIVE_MODELS = [...FALLBACK_MODELS];

const MAX_NEWS_ITEMS = 140;
const MAX_POSTS_ITEMS = 40;
const MAX_GUIDES_ITEMS = 35;
const MAX_LISTS_ITEMS = 14;

const VALID_NEWS_CATS = new Set(["launch", "tips", "eggs", "weapons", "vehicles", "items", "world"]);
const VALID_STATUSES = new Set(["confirmed", "reported", "disputed"]);
const CATEGORY_KEYS = ["cars", "weapons", "money", "gear"];

const GAMING_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" }
];

// Deterministic Rockstar / GTA canonical brand & item typo fixer
const CANONICAL_REPLACEMENTS = [
  [/\bGotti\b/gi, "Grotti"],
  [/\bGroti\b/gi, "Grotti"],
  [/\bPegasi\b/gi, "Pegassi"],
  [/\bPeggassi\b/gi, "Pegassi"],
  [/\bDewbauch(e|ee)?\b/gi, "Dewbauchee"],
  [/\bTruffad\b/gi, "Truffade"],
  [/\bBenefacter\b/gi, "Benefactor"],
  [/\bLampdati\b/gi, "Lampadati"],
  [/\bOverflod\b/gi, "Överflöd"],
  [/\bUbermacht\b/gi, "Übermacht"],
  [/\bPfisterr\b/gi, "Pfister"],
  [/\bFister\b/gi, "Pfister"],
  [/\bDeclase\b/gi, "Declasse"],
  [/\bBravdo\b/gi, "Bravado"],
  [/\bImpont\b/gi, "Imponte"],
  [/\bInvetro\b/gi, "Invetero"],
  [/\bOcelote\b/gi, "Ocelot"],
  [/\bProgene\b/gi, "Progen"],
  [/\bAnis\b/gi, "Annis"],
  [/\bMaibastu\b/gi, "Maibatsu"],
  [/\bNagaskai\b/gi, "Nagasaki"],
  [/\bShitzhu\b/gi, "Shitzu"],
  [/\bGalivanter\b/gi, "Gallivanter"],
  [/\bVapidde\b/gi, "Vapid"],
  [/\bZentoro\b/gi, "Zentorno"],
  [/\bInfernous\b/gi, "Infernus"],
  [/\bBanshe\b/gi, "Banshee"],
  [/\bCheetah\s+Clasico\b/gi, "Cheetah Classic"],
  [/\bKurma\b/gi, "Kuruma"],
  [/\bKrieger\s+RS\b/gi, "Krieger"]
];

const CANONICAL_BRAND_GLOSSARY =
  "Grotti, Pegassi, Dewbauchee, Truffade, Pfister, Bravado, Declasse, Vapid, Karin, Albany, Imponte, Benefactor, Lampadati, Ocelot, Progen, Coil, Übermacht, Överflöd, Annis, Dinka, Shitzu, Nagasaki, Maibatsu, Enus, Gallivanter, Obey, Invetero, Mammoth, HVY, Western, Principe, Canis, Weeny, Vom Feuer, Hawk & Little, Shrewsbury";

const CATEGORY_CONFIG = {
  cars: {
    label: "Cars & Vehicles",
    cap: 60,
    targetPerRun: 18,
    factKey1: "Top speed",
    factExample1: "132 mph",
    factKey2: "Class",
    factExample2: "Super, Sports, Muscle, Sedan, Compact, SUV, Motorcycle, or Off-Road",
    bottomTierGuidance:
      "Include starter sedans, heavy SUVs, slow compacts, budget vans, and overpriced/poor-handling cars in ranks 6-12 (B and C tiers), not just S-tier supercars.",
    ytQueries: [
      "GTA 6 car tier list best and worst vehicles ranked",
      "GTA 6 every car ranked fast slow starter vehicles"
    ],
    rssUrls: [
      "https://news.google.com/rss/search?q=%22GTA+6%22+(%22cars%22+OR+%22vehicles%22+OR+%22tier+list%22+OR+supercar+OR+motorcycle+OR+%22worst+cars%22)+when:60d&hl=en-US&gl=US&ceid=US:en",
      "https://news.google.com/rss/search?q=site:youtube.com+%22GTA+6%22+(cars+OR+vehicles+OR+tier+list+OR+ranked)&hl=en-US&gl=US&ceid=US:en"
    ]
  },
  weapons: {
    label: "Weapons & Loadouts",
    cap: 60,
    targetPerRun: 18,
    factKey1: "Damage",
    factExample1: "High (2-shot chest) or Low (starter sidearm)",
    factKey2: "Best use",
    factExample2: "Mid-range firefights, stealth, close quarters, or early-game backup",
    bottomTierGuidance:
      "Include weak starter pistols, low-DPS SMGs, slow-reload shotguns, situational melee weapons, and outclassed rifles in ranks 6-12 (B and C tiers), not just meta rifles.",
    ytQueries: [
      "GTA 6 weapon tier list best and worst guns ranked",
      "GTA 6 all guns ranked rifles pistols shotguns melee"
    ],
    rssUrls: [
      "https://news.google.com/rss/search?q=%22GTA+6%22+(%22weapons%22+OR+%22guns%22+OR+%22weapon+tier+list%22+OR+rifle+OR+pistol+OR+shotgun)+when:60d&hl=en-US&gl=US&ceid=US:en",
      "https://news.google.com/rss/search?q=site:youtube.com+%22GTA+6%22+(weapons+OR+guns+OR+tier+list+OR+loadout)&hl=en-US&gl=US&ceid=US:en"
    ]
  },
  money: {
    label: "Money Methods & Economy",
    cap: 28,
    targetPerRun: 10,
    factKey1: "Payout",
    factExample1: "$120,000 - $250,000 per run or $8,000/hr early grind",
    factKey2: "Time",
    factExample2: "15-20 min solo, Passive hourly, or 5 min quick hustle",
    bottomTierGuidance:
      "Every entry MUST be a genuinely distinct income mechanic — NEVER split the same activity into synonyms (e.g. do NOT list both 'Vault Jobs' and 'Vault Raids', or both 'Store Robberies' and 'Convenience Store Holdups'). Include slow or low-payout early hustles (e.g. ATM/register skims, taxi/delivery odd jobs, low-end car flipping, petty street muggings) in ranks 6-12 (B and C tiers) alongside top-tier heists and businesses.",
    ytQueries: [
      "GTA 6 money methods tier list best and worst ways to make money",
      "GTA 6 heist payout business side hustle money guide"
    ],
    rssUrls: [
      "https://news.google.com/rss/search?q=%22GTA+6%22+(%22make+money%22+OR+%22money+guide%22+OR+%22money+methods%22+OR+heist+OR+robbery+OR+business+OR+%22side+hustle%22)+when:60d&hl=en-US&gl=US&ceid=US:en",
      "https://news.google.com/rss/search?q=site:youtube.com+%22GTA+6%22+(money+OR+heist+OR+cash+OR+business+OR+tier+list)&hl=en-US&gl=US&ceid=US:en"
    ]
  },
  gear: {
    label: "Gear, Tools, Attachments & Upgrades",
    cap: 60,
    targetPerRun: 20,
    factKey1: "Effect",
    factExample1: "Unlocks high-end cars silently, +40% armor, or reduces recoil",
    factKey2: "Unlock",
    factExample2: "Pawn shop, Ammu-Nation, Safehouse bench, or Mechanic shop",
    bottomTierGuidance:
      "Cover the FULL spectrum of GTA 6 gear: body armor tiers, car-theft tools (slim jim, key fob cloner, OBD scanner), heist gadgets (signal jammer, thermal charge, hacking deck, duffel bag), weapon attachments (suppressors, extended mags, scopes, flashlights, grips), survival/utility items (parachute, rebreather, binoculars, medkits, night vision), and vehicle upgrades (bulletproof tires, turbo, armor plating). Put basic, early-game, situational, or outclassed gear in ranks 6-12 (B and C tiers).",
    ytQueries: [
      "GTA 6 best gear tools equipment armor attachments tier list",
      "GTA 6 upgrades items gadgets unlock early worth buying"
    ],
    rssUrls: [
      "https://news.google.com/rss/search?q=%22GTA+6%22+(gear+OR+upgrades+OR+armor+OR+tools+OR+attachments+OR+equipment+OR+gadgets+OR+lockpick+OR+cloner+OR+backpack+OR+duffel)+when:60d&hl=en-US&gl=US&ceid=US:en",
      "https://news.google.com/rss/search?q=site:youtube.com+%22GTA+6%22+(gear+OR+upgrades+OR+tools+OR+attachments+OR+armor+OR+items)&hl=en-US&gl=US&ceid=US:en"
    ]
  }
};

const GENERAL_RSS_FEEDS = [
  {
    name: "Google News (GTA 6 Latest)",
    url: "https://news.google.com/rss/search?q=%22GTA+6%22+OR+%22Grand+Theft+Auto+VI%22+when:14d&hl=en-US&gl=US&ceid=US:en",
    requireGtaMatch: false
  },
  {
    name: "Google News (GTA 6 Guides & Tips)",
    url: "https://news.google.com/rss/search?q=%22GTA+6%22+(guide+OR+tips+OR+walkthrough+OR+%22tier+list%22+OR+secret+OR+%22easter+egg%22)+when:30d&hl=en-US&gl=US&ceid=US:en",
    requireGtaMatch: false
  },
  { name: "IGN", url: "https://feeds.feedburner.com/ign/games-all", requireGtaMatch: true },
  { name: "Eurogamer", url: "https://www.eurogamer.net/feed", requireGtaMatch: true },
  { name: "VGC", url: "https://www.videogameschronicle.com/feed/", requireGtaMatch: true },
  { name: "PC Gamer", url: "https://www.pcgamer.com/rss/", requireGtaMatch: true },
  { name: "GamesRadar", url: "https://www.gamesradar.com/rss/", requireGtaMatch: true },
  { name: "Dexerto", url: "https://www.dexerto.com/feed/", requireGtaMatch: true },
  { name: "Polygon", url: "https://www.polygon.com/rss/index.xml", requireGtaMatch: true },
  { name: "GameSpot", url: "https://www.gamespot.com/feeds/mashup/", requireGtaMatch: true },
  { name: "Kotaku", url: "https://kotaku.com/rss", requireGtaMatch: true },
  { name: "VG247", url: "https://www.vg247.com/feed", requireGtaMatch: true },
  { name: "TheGamer", url: "https://www.thegamer.com/feed/", requireGtaMatch: true },
  { name: "DualShockers", url: "https://www.dualshockers.com/feed/", requireGtaMatch: true }
];

const GTA_REGEX = /\b(gta\s*6|gta\s*vi|grand\s+theft\s+auto\s*(6|vi)|leonida|vice\s+city|rockstar\s+games)\b/i;

const BOILERPLATE_IDS = new Set([
  "ps5-system-update",
  "saving",
  "settings-deadzone"
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function slugify(str) {
  return String(str || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// Applies deterministic Rockstar/GTA canonical spelling fixes
function fixCanonicalName(name) {
  let out = cleanHeadline(name || "");
  for (const [pattern, replacement] of CANONICAL_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, " ").trim();
}

function decodeHtml(str) {
  if (!str) return "";
  let s = String(str).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  s = s
    .replace(/<[^>]*>/g, " ")
    .replace(/<a\b[\s\S]*$/gi, " ")
    .replace(/href\s*=\s*["']?https?:\/\/\S+/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return s;
}

function cleanHeadline(title) {
  let t = decodeHtml(title || "");
  t = t.replace(/\s+-\s+[^-]{2,45}$/, "").trim();
  t = t
    .replace(/\s*;\s*/g, ", ")
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/\s+--\s+/g, ", ")
    .replace(/,\s*,/g, ",")
    .trim();
  return t;
}

function cleanBodyText(body, title, source) {
  const cleaned = decodeHtml(body || "");
  if (!cleaned || cleaned.length < 15) return "";
  const normBody = cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normTitle = String(title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const normSource = String(source || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normBody === normTitle || normBody === normTitle + normSource) return "";
  return cleaned.slice(0, 260);
}

function safeUrl(u) {
  return typeof u === "string" && /^https:\/\//i.test(u.trim()) ? u.trim() : "";
}

function parseDateIso(raw) {
  if (!raw) return todayIso();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return todayIso();
  const iso = d.toISOString().slice(0, 10);
  return iso > todayIso() ? todayIso() : iso;
}

function normalizeWords(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 4 && !["with", "from", "that", "this", "what", "when", "your", "have", "into", "about", "after", "rockstar", "grand", "theft", "auto"].includes(w))
  );
}

function isSimilarHeadline(a, b) {
  const wa = normalizeWords(a);
  const wb = normalizeWords(b);
  if (!wa.size || !wb.size) return false;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return (overlap / Math.min(wa.size, wb.size)) >= 0.65;
}

// Normalizes item names to catch duplicates like "Vault Jobs" vs "Vault Raids"
function canonicalConceptKey(catKey, name) {
  const base = fixCanonicalName(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");

  const words = base.split(/\s+/).filter(Boolean);
  if (catKey !== "money") {
    return words.join(" ");
  }

  const MONEY_NOISE = new Set([
    "job", "jobs", "raid", "raids", "heist", "heists", "robbery", "robberies",
    "holdup", "holdups", "mission", "missions", "run", "runs", "grind", "grinding",
    "farm", "farming", "method", "methods", "hustle", "hustles", "contract", "contracts",
    "gig", "gigs", "work", "money", "cash", "income", "payout", "the", "and", "for"
  ]);

  const core = words
    .map(w => w.replace(/(ies)$/, "y").replace(/(s)$/, ""))
    .filter(w => w.length > 1 && !MONEY_NOISE.has(w));

  return core.length > 0 ? core.sort().join(" ") : words.join(" ");
}

function isDuplicateCategoryItem(catKey, nameA, nameB) {
  const fixedA = fixCanonicalName(nameA);
  const fixedB = fixCanonicalName(nameB);
  if (slugify(fixedA) === slugify(fixedB)) return true;

  const keyA = canonicalConceptKey(catKey, fixedA);
  const keyB = canonicalConceptKey(catKey, fixedB);
  if (keyA && keyB && keyA === keyB) return true;

  return false;
}

// Mirrors Beat Six index.html scoring so we can measure exact tier distribution
function criticScoreOf(it) {
  const rs = (it.ranks || []).filter(r => Number.isFinite(r.rank) && r.rank >= 1);
  if (!rs.length) return null;
  const pts = rs.map(r => Math.max(40, 100 - 6 * (r.rank - 1)));
  return Math.round(pts.reduce((a, b) => a + b, 0) / pts.length);
}

function tierOfScore(score) {
  if (score == null) return "none";
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  return "C";
}

function getTierDistribution(list) {
  const dist = { S: 0, A: 0, B: 0, C: 0 };
  for (const it of list) {
    const t = tierOfScore(criticScoreOf(it));
    if (dist[t] != null) dist[t]++;
  }
  return dist;
}

// Cleans typos (like "Gotti Cheetah" -> "Grotti Cheetah") & merges duplicate entries (like "Vault Jobs" + "Vault Raids")
function cleanAndDeduplicateCategory(catKey, list) {
  let fixedNames = 0;
  let mergedCount = 0;
  const cleaned = [];

  for (const rawItem of list) {
    if (!rawItem || !rawItem.name) continue;
    const correctedName = fixCanonicalName(rawItem.name);
    if (correctedName !== rawItem.name) fixedNames++;

    const item = {
      ...rawItem,
      id: slugify(correctedName) || rawItem.id,
      name: correctedName,
      ranks: Array.isArray(rawItem.ranks) ? [...rawItem.ranks] : []
    };

    const existing = cleaned.find(x => isDuplicateCategoryItem(catKey, x.name, item.name));
    if (!existing) {
      cleaned.push(item);
    } else {
      mergedCount++;
      // Merge unique critic ranks into the kept entry
      for (const r of item.ranks) {
        if (!r || !r.source) continue;
        const hasSrc = existing.ranks.some(er => er.source && er.source.toLowerCase() === r.source.toLowerCase());
        if (!hasSrc) existing.ranks.push(r);
      }
      // Keep the richer blurb/facts if the existing one is thin
      if ((!existing.blurb || existing.blurb.length < 25) && item.blurb) existing.blurb = item.blurb;
      if ((!existing.get || existing.get.length < 10) && item.get) existing.get = item.get;
      existing.facts = { ...(item.facts || {}), ...(existing.facts || {}) };
    }
  }

  return { items: cleaned, fixedNames, mergedCount };
}

function extractTag(block, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function extractJsonObject(rawText) {
  let cleaned = String(rawText || "")
    .trim()
    .replace(new RegExp("^\\x60{3}(?:json)?\\s*", "i"), "")
    .replace(new RegExp("\\s*\\x60{3}$", "i"), "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Response did not contain a valid JSON object");
  }
}

async function fetchTextWithTimeout(url, timeoutMs = 10000, accept = "text/html,application/xml,*/*") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverWorkingModels() {
  if (!GEMINI_API_KEY) return;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`
    );
    const json = await resp.json();
    if (!resp.ok || json.error) {
      geminiLastError = `Model list HTTP ${resp.status}: ${json.error?.message || "Invalid API key"}`;
      console.warn(`[Gemini:Init] ${geminiLastError}`);
      return;
    }

    const available = (json.models || [])
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map(m => String(m.name || "").replace(/^models\//, ""))
      .filter(name => /^gemini-.*flash/i.test(name) && !/image|tts|audio|live|thinking|robotics|computer/i.test(name));

    if (available.length > 0) {
      const preferred = [];
      for (const f of FALLBACK_MODELS) {
        if (available.includes(f)) preferred.push(f);
      }
      for (const m of available) {
        if (!preferred.includes(m)) preferred.push(m);
      }
      ACTIVE_MODELS = preferred.slice(0, 4);
      console.log(`[Gemini:Init] Discovered live Flash models: ${ACTIVE_MODELS.join(", ")}`);
    }
  } catch (err) {
    geminiLastError = `Model discovery failed: ${err.message}`;
    console.warn(`[Gemini:Init] ${geminiLastError}`);
  }
}

function parseRssXml(xml, feedMeta) {
  const results = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];

  for (const block of itemBlocks) {
    const rawTitle = extractTag(block, "title");
    const rawDesc = extractTag(block, "description") || extractTag(block, "summary") || "";
    const rawPubDate = extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated") || "";
    const rawSource = extractTag(block, "source");

    let link = extractTag(block, "link");
    if (!link) {
      const hrefMatch = block.match(/<link[^>]+href=["'](https?:\/\/[^"']+)["']/i);
      if (hrefMatch) link = hrefMatch[1];
    }
    link = safeUrl(link.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
    if (!rawTitle || !link) continue;

    const fullText = `${rawTitle} ${rawDesc}`;
    if (feedMeta.requireGtaMatch && !GTA_REGEX.test(fullText)) continue;

    let publisher = decodeHtml(rawSource);
    if (!publisher) {
      const dashPub = decodeHtml(rawTitle).match(/\s+-\s+([^-]{2,45})$/);
      publisher = dashPub ? dashPub[1].trim() : feedMeta.name.replace(/\s*\(.*?\)/g, "");
    }

    const title = cleanHeadline(rawTitle);
    const body = cleanBodyText(rawDesc, title, publisher);
    if (title.length < 16) continue;

    const isYt = /youtube\.com|youtu\.be/i.test(link) || /^youtube$/i.test(publisher);
    results.push({
      title,
      body,
      source: publisher || (isYt ? "YouTube Creator" : "Gaming Press"),
      url: link,
      kind: isYt ? "youtube" : "web",
      categoryHint: feedMeta.categoryHint || null,
      added: parseDateIso(rawPubDate)
    });
  }
  return results;
}

async function fetchArticleExcerpt(url) {
  if (!url || /news\.google\.com|youtube\.com|youtu\.be/i.test(url)) return "";
  const html = await fetchTextWithTimeout(url, 4500, "text/html");
  if (!html) return "";

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");

  const headingsAndParas = [];
  const matches = stripped.matchAll(/<(h2|h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi);
  for (const m of matches) {
    const txt = decodeHtml(m[2]);
    if (txt.length >= 25 && txt.length <= 450) {
      headingsAndParas.push(txt);
    }
    if (headingsAndParas.join(" ").length > 1800) break;
  }

  return headingsAndParas.join(" | ").slice(0, 1800);
}

async function scrapeYouTubeSearchNoKey(query, maxItems = 8) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAMSAhAB`;
  const html = await fetchTextWithTimeout(url, 9000, "text/html");
  if (!html) return [];

  const match = html.match(/var\s+ytInitialData\s*=\s*(\{[\s\S]*?\});<\/script>/) ||
                html.match(/window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return [];

  try {
    const data = JSON.parse(match[1]);
    const found = [];

    function walk(node) {
      if (!node || typeof node !== "object" || found.length >= maxItems) return;
      if (node.videoRenderer && node.videoRenderer.videoId) {
        const vr = node.videoRenderer;
        const title = (vr.title?.runs || []).map(r => r.text).join("") || vr.title?.simpleText || "";
        const channel = (vr.ownerText?.runs || []).map(r => r.text).join("") || "YouTube Creator";
        const snippet = (vr.detailedMetadataSnippets?.[0]?.snippetText?.runs || []).map(r => r.text).join("") ||
                        (vr.descriptionSnippet?.runs || []).map(r => r.text).join("") || "";
        if (title && GTA_REGEX.test(`${title} ${snippet}`)) {
          found.push({
            title: cleanHeadline(title),
            body: cleanBodyText(snippet, title, channel),
            source: channel,
            url: `https://www.youtube.com/watch?v=${vr.videoId}`,
            kind: "youtube",
            added: todayIso()
          });
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const el of node) walk(el);
      } else {
        for (const val of Object.values(node)) walk(val);
      }
    }

    walk(data);
    return found;
  } catch {
    return [];
  }
}

async function fetchYouTubeForCategory(catKey) {
  const cfg = CATEGORY_CONFIG[catKey];
  const videos = [];
  const seen = new Set();

  if (YOUTUBE_API_KEY) {
    const publishedAfter = new Date(Date.now() - 90 * 86400000).toISOString();
    for (const q of cfg.ytQueries) {
      try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=relevance&maxResults=8&publishedAfter=${encodeURIComponent(publishedAfter)}&q=${encodeURIComponent(q)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const json = await resp.json();
        for (const item of (json.items || [])) {
          const vidId = item.id?.videoId;
          const snip = item.snippet;
          if (!vidId || !snip?.title || seen.has(vidId)) continue;
          seen.add(vidId);
          videos.push({
            title: cleanHeadline(snip.title),
            body: cleanBodyText(snip.description || "", snip.title, snip.channelTitle),
            source: snip.channelTitle || "YouTube Creator",
            url: `https://www.youtube.com/watch?v=${vidId}`,
            kind: "youtube",
            categoryHint: catKey,
            added: parseDateIso(snip.publishedAt)
          });
        }
      } catch (err) {
        console.warn(`[YouTube API:${catKey}] Failed: ${err.message}`);
      }
    }
  }

  if (videos.length < 6) {
    for (const q of cfg.ytQueries) {
      const scraped = await scrapeYouTubeSearchNoKey(q, 8);
      for (const v of scraped) {
        if (seen.has(v.url)) continue;
        seen.add(v.url);
        videos.push({ ...v, categoryHint: catKey });
      }
    }
  }

  console.log(`[YouTube:${catKey}] Collected ${videos.length} creator videos`);
  return videos;
}

async function fetchAllOnlineArticles() {
  const general = [];
  const byCategory = { cars: [], weapons: [], money: [], gear: [] };

  for (const feed of GENERAL_RSS_FEEDS) {
    const xml = await fetchTextWithTimeout(feed.url, 10000, "application/rss+xml,application/xml,text/xml,*/*");
    if (!xml) continue;
    const parsed = parseRssXml(xml, feed);
    console.log(`[RSS] ${feed.name}: ${parsed.length} matching articles`);
    general.push(...parsed);
  }

  for (const catKey of CATEGORY_KEYS) {
    for (const url of CATEGORY_CONFIG[catKey].rssUrls) {
      const xml = await fetchTextWithTimeout(url, 10000, "application/rss+xml,application/xml,text/xml,*/*");
      if (!xml) continue;
      const parsed = parseRssXml(xml, {
        name: `Meta RSS (${catKey})`,
        requireGtaMatch: false,
        categoryHint: catKey
      });
      byCategory[catKey].push(...parsed);
    }
    console.log(`[MetaRSS:${catKey}] Collected ${byCategory[catKey].length} category-specific links`);
  }

  for (const item of general) {
    const text = `${item.title} ${item.body}`.toLowerCase();
    if (/\b(car|cars|supercar|vehicle|bike|motorcycle|speed|garage|drift)\b/.test(text)) byCategory.cars.push(item);
    if (/\b(weapon|gun|rifle|pistol|shotgun|sniper|loadout|combat|dps)\b/.test(text)) byCategory.weapons.push(item);
    if (/\b(money|cash|heist|robbery|payout|million|economy|farm|profit|business|hustle)\b/.test(text)) byCategory.money.push(item);
    if (/\b(gear|upgrade|armor|tool|equipment|attachment|lockpick|cloner|gadget|vest|backpack|duffel|jammer|scope|suppressor)\b/.test(text)) byCategory.gear.push(item);
  }

  for (const catKey of CATEGORY_KEYS) {
    const directArticles = byCategory[catKey]
      .filter(a => a.kind === "web" && !/news\.google\.com/i.test(a.url))
      .slice(0, 4);
    await Promise.all(directArticles.map(async (art) => {
      const excerpt = await fetchArticleExcerpt(art.url);
      if (excerpt) art.excerpt = excerpt;
    }));
  }

  return { general, byCategory };
}

function heuristicCategory(title, body) {
  const s = `${title} ${body}`.toLowerCase();
  if (/\b(easter egg|secret|mystery|bigfoot|ufo|hidden|alien)\b/.test(s)) return "eggs";
  if (/\b(car|cars|supercar|vehicle|bike|motorcycle|speed|handling|garage|drift)\b/.test(s)) return "vehicles";
  if (/\b(gun|weapon|rifle|pistol|shotgun|loadout|combat|aim|nerf|buff|dps)\b/.test(s)) return "weapons";
  if (/\b(money|cash|heist|robbery|payout|million|economy|farm|profit|business)\b/.test(s)) return "items";
  if (/\b(tip|tips|guide|how to|beginner|settings|trick|mistake|stamina|walkthrough)\b/.test(s)) return "tips";
  if (/\b(patch|update|hotfix|install|download|launch|performance|fps|ps5|xbox|pc)\b/.test(s)) return "launch";
  return "world";
}

function heuristicHeroScore(item) {
  let score = 50;
  const s = `${item.title} ${item.body}`.toLowerCase();
  const ageDays = Math.max(0, Math.round((Date.now() - new Date((item.added || todayIso()) + "T12:00:00Z").getTime()) / 86400000));
  score += Math.max(0, 30 - ageDays * 4);
  if (/\b(patch|update|meta|fastest|best|new|confirmed|rockstar|official|heist|map|dlc|online|trailer|record|release)\b/.test(s)) score += 18;
  if (/\b(system update|firmware|install size|deadzone|how to save)\b/.test(s)) score -= 80;
  if (BOILERPLATE_IDS.has(item.id)) score -= 120;
  return score;
}

let geminiCallCount = 0;
let geminiSuccessCount = 0;
let geminiFailCount = 0;
let geminiLastError = "";

async function callGeminiJson(label, promptText, responseSchema) {
  if (!GEMINI_API_KEY) {
    geminiLastError = "GEMINI_API_KEY secret is empty or missing";
    console.warn(`[Gemini:${label}] Skipped — ${geminiLastError}.`);
    return null;
  }

  if (geminiCallCount > 0) {
    await sleep(7500);
  }
  geminiCallCount++;

  let lastErr = null;
  for (const modelId of ACTIVE_MODELS) {
    const attempts = responseSchema ? [true, false] : [false];

    for (const useSchema of attempts) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
        const generationConfig = {
          responseMimeType: "application/json",
          temperature: 0.3,
          maxOutputTokens: 8192
        };

        if (/2\.5/.test(modelId)) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        if (useSchema && responseSchema) {
          generationConfig.responseSchema = responseSchema;
        }

        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            safetySettings: GAMING_SAFETY_SETTINGS,
            generationConfig
          })
        });

        const json = await resp.json();
        if (!resp.ok || json.error) {
          lastErr = new Error(`${modelId} (schema=${useSchema}) HTTP ${resp.status}: ${json.error?.message || "Unknown error"}`);
          console.warn(`[Gemini:${label}] ${lastErr.message}`);
          if (resp.status === 429) await sleep(10000);
          continue;
        }

        const parts = json.candidates?.[0]?.content?.parts || [];
        const rawText = parts.map(p => p.text || "").join("").trim();
        if (!rawText) {
          lastErr = new Error(`${modelId} empty response (finishReason=${json.candidates?.[0]?.finishReason || "unknown"})`);
          console.warn(`[Gemini:${label}] ${lastErr.message}`);
          continue;
        }

        const parsed = extractJsonObject(rawText);
        geminiSuccessCount++;
        console.log(`[Gemini:${label}] Success via ${modelId} (schema=${useSchema})`);
        return parsed;
      } catch (err) {
        lastErr = err;
        console.warn(`[Gemini:${label}] ${modelId} (schema=${useSchema}) error: ${err.message}`);
      }
    }
  }

  geminiFailCount++;
  geminiLastError = lastErr?.message || "All models failed";
  console.warn(`[Gemini:${label}] All models failed: ${geminiLastError}`);
  return null;
}

// CALL 1: Enrich & rank fresh RSS news items
async function enrichNewsWithGemini(candidates) {
  if (!GEMINI_API_KEY || !candidates.length) return null;

  const batch = candidates.slice(0, 35).map((c, idx) => ({
    idx,
    title: c.title,
    body: c.body,
    source: c.source,
    added: c.added
  }));

  const schema = {
    type: "OBJECT",
    properties: {
      items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            idx: { type: "INTEGER" },
            keep: { type: "BOOLEAN" },
            title: { type: "STRING" },
            body: { type: "STRING" },
            cat: { type: "STRING" },
            status: { type: "STRING" },
            heroScore: { type: "INTEGER" }
          },
          required: ["idx", "keep", "title", "body", "cat", "status", "heroScore"]
        }
      }
    },
    required: ["items"]
  };

  const prompt = `You are the news editor for Beat Six, a GTA 6 guide and meta aggregator.
Review these real, freshly fetched GTA 6 news items:
${JSON.stringify(batch)}

Return valid JSON matching {"items":[{"idx":0,"keep":true,"title":"...","body":"...","cat":"world","status":"reported","heroScore":80}]}.
Rules:
- Set keep=false ONLY if it is pure off-topic spam, non-GTA-6, or obvious clickbait rumor garbage.
- Clean up title if needed (no semicolons, no em-dashes).
- Write a crisp, plain-text 1-2 sentence summary (100-190 chars) with NO HTML tags and NO URLs.
- Assign cat strictly from: "launch", "tips", "eggs", "weapons", "vehicles", "items", "world".
- Assign status strictly from: "confirmed", "reported", "disputed".
- Assign heroScore 1-100 based on front-page value for GTA 6 players right now.`;

  const res = await callGeminiJson("NewsEnrich", prompt, schema);
  if (!res || !Array.isArray(res.items)) return null;

  const enriched = [];
  for (const row of res.items) {
    if (!row.keep) continue;
    const orig = candidates[row.idx];
    if (!orig) continue;
    enriched.push({
      id: slugify(row.title || orig.title),
      title: cleanHeadline(row.title || orig.title),
      body: decodeHtml(row.body || orig.body || "").slice(0, 240),
      cat: VALID_NEWS_CATS.has(row.cat) ? row.cat : heuristicCategory(orig.title, orig.body),
      status: VALID_STATUSES.has(row.status) ? row.status : "reported",
      source: orig.source,
      url: orig.url,
      added: orig.added,
      heroScore: Number.isFinite(row.heroScore) ? row.heroScore : heuristicHeroScore(orig)
    });
  }
  return enriched;
}

// CALLS 2-5: Dedicated Per-Category Meta Extractor (Balanced Across S, A, B, and C/Bottom Tiers)
async function expandSingleMetaCategory(data, catKey, ytSources, webSources) {
  const cfg = CATEGORY_CONFIG[catKey];
  const list = data.categories[catKey] || [];
  const slotsLeft = cfg.cap - list.length;
  if (!GEMINI_API_KEY) return { addedItems: 0, addedRanks: 0 };

  const targetNew = Math.min(cfg.targetPerRun, Math.max(0, slotsLeft));
  const dist = getTierDistribution(list);

  // Build explicit tier-balancing quotas based on what is currently underrepresented
  const topHeavy = (dist.S + dist.A) > (dist.B + dist.C + 2);
  const quotaGuidance = topHeavy
    ? `CURRENT BOARD IS TOP-HEAVY (S=${dist.S}, A=${dist.A}, B=${dist.B}, C=${dist.C}).
To balance the tier list top-to-bottom, your newItems MUST follow this rank quota:
- At most 1-2 items with rank 1-2 (S tier, score 90-100)
- At most 2-3 items with rank 3-4 (A tier, score 80-89)
- At least 35% of newItems MUST have rank 5-6 (B tier, score 70-76: solid mid-tier / situational)
- At least 45% of newItems MUST have rank 7-12 (C / bottom tier, score 40-64: starter, budget, slow, weak, or outclassed)`
    : `Current tier counts: S=${dist.S}, A=${dist.A}, B=${dist.B}, C=${dist.C}.
Distribute your newItems EVENLY across all four tiers (~25% each):
- ~25% rank 1-2 (S tier, score 90-100)
- ~25% rank 3-4 (A tier, score 80-89)
- ~25% rank 5-6 (B tier, score 70-76)
- ~25% rank 7-12 (C / bottom tier, score 40-64)`;

  const seen = new Set();
  const combinedSources = [];
  const maxLen = Math.max(ytSources.length, webSources.length);
  for (let i = 0; i < maxLen && combinedSources.length < 28; i++) {
    for (const s of [ytSources[i], webSources[i]]) {
      if (!s || !safeUrl(s.url) || seen.has(s.url)) continue;
      seen.add(s.url);
      combinedSources.push(s);
    }
  }

  if (combinedSources.length === 0) {
    console.warn(`[Meta:${catKey}] No sources available for this category.`);
    return { addedItems: 0, addedRanks: 0 };
  }

  const compactSources = combinedSources.map((s, idx) => ({
    idx,
    kind: s.kind || "web",
    source: s.source,
    title: s.title,
    summary: s.excerpt || s.body || ""
  }));

  const existingSummary = list.map(i => ({
    id: i.id,
    name: i.name,
    tier: tierOfScore(criticScoreOf(i)),
    ranksCount: (i.ranks || []).length
  }));

  const schema = {
    type: "OBJECT",
    properties: {
      newItems: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            type: { type: "STRING" },
            blurb: { type: "STRING" },
            get: { type: "STRING" },
            factVal1: { type: "STRING" },
            factVal2: { type: "STRING" },
            rank1: { type: "INTEGER" },
            quote1: { type: "STRING" },
            sourceIdx1: { type: "INTEGER" },
            rank2: { type: "INTEGER" },
            quote2: { type: "STRING" },
            sourceIdx2: { type: "INTEGER" }
          },
          required: ["name", "type", "blurb", "get", "factVal1", "factVal2", "rank1", "quote1", "sourceIdx1"]
        }
      },
      extraRanks: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            itemId: { type: "STRING" },
            rank: { type: "INTEGER" },
            quote: { type: "STRING" },
            sourceIdx: { type: "INTEGER" }
          },
          required: ["itemId", "rank", "quote", "sourceIdx"]
        }
      }
    },
    required: ["newItems", "extraRanks"]
  };

  const prompt = `Context: Benign video game tier-list curation for Beat Six (a GTA 6 Meta aggregator).
Category: "${catKey}" (${cfg.label})

Items ALREADY in this category (DO NOT duplicate or create synonym variants of any of these):
${JSON.stringify(existingSummary)}

Verified YouTube videos and online articles for "${catKey}" (0-indexed):
${JSON.stringify(compactSources)}

TIER DISTRIBUTION RULES (CRITICAL):
${quotaGuidance}
Category guidance: ${cfg.bottomTierGuidance}

SPELLING & CANONICAL NAME RULES (CRITICAL):
- Double-check every official Rockstar / GTA brand and item spelling before outputting.
- Exact spellings include: ${CANONICAL_BRAND_GLOSSARY}.
- NEVER misspell "Grotti" as "Gotti", "Pegassi" as "Pegasi", or "Dewbauchee" as "Dewbauch".

Task:
Return valid JSON with two arrays: "newItems" and "extraRanks".
1. In "newItems", extract up to ${targetNew} brand-new, distinct GTA 6 ${cfg.label} items NOT already listed above (minimum 10 if slots allow).
   - Follow the tier distribution quota above strictly (ranks 1-12; higher rank number = lower tier).
   - factVal1 is "${cfg.factKey1}" (e.g. "${cfg.factExample1}").
   - factVal2 is "${cfg.factKey2}" (e.g. "${cfg.factExample2}").
   - Cite 1 to 2 distinct sourceIdx values (prefer pairing 1 YouTube creator + 1 web article when both are present).
   - Keep blurb under 160 chars and quotes under 130 chars. Plain text only, no HTML/URLs.
2. In "extraRanks", add 4 to 6 honest critic rankings (ranks 1-12) for existing itemIds above. If an existing item is overrated or mid-tier, give it an honest rank (5-10) so the board stays realistically calibrated.`;

  const res = await callGeminiJson(`Meta:${catKey}`, prompt, schema);
  if (!res) return { addedItems: 0, addedRanks: 0 };

  let addedItems = 0;
  let addedRanks = 0;

  for (const item of (res.newItems || [])) {
    if (list.length >= cfg.cap) break;
    const cleanName = fixCanonicalName(item.name);
    const id = slugify(cleanName);
    if (!id || cleanName.length < 2) continue;
    if (list.some(x => isDuplicateCategoryItem(catKey, x.name, cleanName))) continue;

    const src1 = combinedSources[item.sourceIdx1] || combinedSources[0];
    if (!src1) continue;

    const facts = {};
    if (item.factVal1) facts[cfg.factKey1] = decodeHtml(item.factVal1).slice(0, 80);
    if (item.factVal2) facts[cfg.factKey2] = decodeHtml(item.factVal2).slice(0, 80);

    const ranks = [
      {
        source: src1.source,
        kind: src1.kind || "web",
        rank: Math.min(12, Math.max(1, Number(item.rank1) || 6)),
        quote: decodeHtml(item.quote1 || "").slice(0, 180),
        url: safeUrl(src1.url)
      }
    ];

    if (Number.isInteger(item.sourceIdx2) && combinedSources[item.sourceIdx2] && combinedSources[item.sourceIdx2].source !== src1.source) {
      const src2 = combinedSources[item.sourceIdx2];
      ranks.push({
        source: src2.source,
        kind: src2.kind || "web",
        rank: Math.min(12, Math.max(1, Number(item.rank2) || 6)),
        quote: decodeHtml(item.quote2 || "").slice(0, 180),
        url: safeUrl(src2.url)
      });
    }

    list.push({
      id,
      name: cleanName,
      type: decodeHtml(item.type || "Standard").slice(0, 40),
      blurb: decodeHtml(item.blurb || "").slice(0, 220),
      get: decodeHtml(item.get || "").slice(0, 140),
      facts,
      ranks
    });
    addedItems++;
  }

  for (const r of (res.extraRanks || [])) {
    const target = list.find(x => x.id === r.itemId);
    const src = combinedSources[r.sourceIdx];
    if (!target || !src) continue;

    target.ranks = target.ranks || [];
    if (target.ranks.some(existing => existing.source.toLowerCase() === src.source.toLowerCase())) continue;

    target.ranks.push({
      source: src.source,
      kind: src.kind || "web",
      rank: Math.min(12, Math.max(1, Number(r.rank) || 5)),
      quote: decodeHtml(r.quote || "").slice(0, 180),
      url: safeUrl(src.url)
    });
    addedRanks++;
  }

  data.categories[catKey] = list;
  const newDist = getTierDistribution(list);
  console.log(`[Meta:${catKey}] +${addedItems} new items, +${addedRanks} extra ranks | Total=${list.length} (S=${newDist.S}, A=${newDist.A}, B=${newDist.B}, C=${newDist.C})`);
  return { addedItems, addedRanks };
}

// CALL 6: Expand Search How-To Guides (data.guides)
async function expandGuidesWithGemini(data, sourcePool) {
  if (!GEMINI_API_KEY || sourcePool.length < 2) return 0;

  const existingGuides = Array.isArray(data.guides) ? data.guides : [];
  if (existingGuides.length >= MAX_GUIDES_ITEMS) return 0;

  const existingTitles = existingGuides.map(g => g.title);
  const compactSources = sourcePool.slice(0, 20).map((s, idx) => ({
    idx,
    kind: s.kind || "web",
    title: s.title,
    body: s.body,
    source: s.source,
    date: s.added
  }));

  const schema = {
    type: "OBJECT",
    properties: {
      guides: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            summary: { type: "STRING" },
            tags: { type: "ARRAY", items: { type: "STRING" } },
            steps: { type: "ARRAY", items: { type: "STRING" } },
            sourceIndexes: { type: "ARRAY", items: { type: "INTEGER" } }
          },
          required: ["title", "summary", "tags", "steps", "sourceIndexes"]
        }
      }
    },
    required: ["guides"]
  };

  const prompt = `You are the guide editor for Beat Six (a GTA 6 answer engine).
Existing guides already on the site (do NOT duplicate these):
${JSON.stringify(existingTitles)}

Recent verified GTA 6 YouTube videos and online articles (0-indexed):
${JSON.stringify(compactSources)}

Create 3 practical, high-demand GTA 6 how-to guides inspired by the sources above.
Rules:
- Clear question or action title (no semicolons or em-dashes).
- 1-2 sentence summary (plain text, no HTML/URLs).
- 4 to 6 concrete, actionable steps.
- Cite 1 to 3 relevant sourceIndexes from the list above.`;

  const res = await callGeminiJson("GuidesExpand", prompt, schema);
  if (!res || !Array.isArray(res.guides)) return 0;

  let added = 0;
  const today = todayIso();

  for (const g of res.guides) {
    const title = cleanHeadline(g.title);
    const id = slugify(title);
    if (!id || !Array.isArray(g.steps) || g.steps.length < 3) continue;
    if (existingGuides.some(x => x.id === id || isSimilarHeadline(x.title, title))) continue;

    const cites = (g.sourceIndexes || [])
      .map(i => sourcePool[i])
      .filter(Boolean)
      .slice(0, 3)
      .map(s => ({
        title: s.title,
        publisher: s.source,
        url: safeUrl(s.url),
        date: s.added
      }));

    if (!cites.length && sourcePool[0]) {
      cites.push({
        title: sourcePool[0].title,
        publisher: sourcePool[0].source,
        url: safeUrl(sourcePool[0].url),
        date: sourcePool[0].added
      });
    }

    existingGuides.unshift({
      id,
      title,
      summary: decodeHtml(g.summary || "").slice(0, 220),
      tags: Array.isArray(g.tags) && g.tags.length ? g.tags.slice(0, 4) : ["Tips", "Guide"],
      steps: g.steps.slice(0, 8).map(st => decodeHtml(st)),
      sources: cites,
      updated: today
    });
    added++;
  }

  data.guides = existingGuides.slice(0, MAX_GUIDES_ITEMS);
  console.log(`[Guides] Added ${added} new Search guides (${data.guides.length} total).`);
  return added;
}

// CALL 7: Expand Discover Checklists & Ranked Lists (data.lists)
async function expandDiscoverListsWithGemini(data, sourcePool) {
  if (!GEMINI_API_KEY || sourcePool.length < 2) return 0;

  const existingLists = Array.isArray(data.lists) ? data.lists : [];
  if (existingLists.length >= MAX_LISTS_ITEMS) return 0;

  const existingIds = existingLists.map(l => ({ id: l.id, title: l.title }));
  const metaRefs = [];
  for (const c of CATEGORY_KEYS) {
    for (const it of (data.categories[c] || []).slice(0, 12)) {
      metaRefs.push({ ref: `${c}/${it.id}`, name: it.name, type: it.type });
    }
  }
  const compactSources = sourcePool.slice(0, 16).map((s, idx) => ({
    idx,
    title: s.title,
    source: s.source
  }));

  const schema = {
    type: "OBJECT",
    properties: {
      lists: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            title: { type: "STRING" },
            dek: { type: "STRING" },
            kind: { type: "STRING" },
            stage: { type: "STRING" },
            entries: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  title: { type: "STRING" },
                  body: { type: "STRING" },
                  where: { type: "STRING" },
                  ref: { type: "STRING" },
                  sourceIdx: { type: "INTEGER" }
                },
                required: ["title", "body"]
              }
            }
          },
          required: ["id", "title", "dek", "kind", "stage", "entries"]
        }
      }
    },
    required: ["lists"]
  };

  const prompt = `You are the curation editor for Beat Six's "Discover" checklists and ranked lists.
Existing lists (do NOT duplicate these):
${JSON.stringify(existingIds)}

Available Beat Six Meta item refs you can optionally link via "ref":
${JSON.stringify(metaRefs)}

Recent verified GTA 6 sources (0-indexed):
${JSON.stringify(compactSources)}

Create 2 fresh, genuinely useful Discover lists (1 "checklist" and 1 "ranked") for GTA 6 players.
Rules:
- Each list must have 5 to 7 concrete entries.
- kind must be strictly "checklist" or "ranked".
- stage should be concise (e.g., "Early game", "Mid game", "Money", "Combat", "Exploration", "Vehicles").
- Only use "ref" if it exactly matches one of the available Beat Six Meta refs above; otherwise leave "ref" empty.
- No semicolons, no em-dashes, no HTML tags, no raw URLs.`;

  const res = await callGeminiJson("ListsExpand", prompt, schema);
  if (!res || !Array.isArray(res.lists)) return 0;

  let added = 0;
  const today = todayIso();
  const validRefs = new Set(metaRefs.map(m => m.ref));

  for (const l of res.lists) {
    const id = slugify(l.id || l.title);
    const title = cleanHeadline(l.title);
    if (!id || !Array.isArray(l.entries) || l.entries.length < 4) continue;
    if (existingLists.some(x => x.id === id || isSimilarHeadline(x.title, title))) continue;

    const entries = l.entries.slice(0, 8).map(e => {
      const src = Number.isInteger(e.sourceIdx) ? sourcePool[e.sourceIdx] : null;
      return {
        title: cleanHeadline(e.title),
        body: decodeHtml(e.body || "").slice(0, 220),
        where: decodeHtml(e.where || "").slice(0, 120),
        ref: validRefs.has(e.ref) ? e.ref : "",
        source: src ? { name: src.source, url: safeUrl(src.url) } : null
      };
    });

    existingLists.unshift({
      id,
      title,
      dek: cleanHeadline(l.dek || ""),
      kind: l.kind === "checklist" ? "checklist" : "ranked",
      stage: l.stage || "Tips",
      updated: today,
      entries
    });
    added++;
  }

  data.lists = existingLists.slice(0, MAX_LISTS_ITEMS);
  console.log(`[Lists] Added ${added} new Discover lists (${data.lists.length} total).`);
  return added;
}

// CALL 8: Publish 1 multi-source cited article per day (data.posts)
async function maybeGenerateCitedArticle(data, freshNews) {
  if (!GEMINI_API_KEY) return false;
  const today = todayIso();
  const existingPosts = Array.isArray(data.posts) ? data.posts : [];
  if (existingPosts.some(p => p.published === today)) {
    console.log("[Articles] Already published an article today; skipping.");
    return false;
  }

  const sourcePool = freshNews
    .filter(n => safeUrl(n.url) && n.title)
    .slice(0, 12)
    .map(n => ({ title: n.title, body: n.body, source: n.source, url: n.url, date: n.added, cat: n.cat }));

  if (sourcePool.length < 3) return false;

  const schema = {
    type: "OBJECT",
    properties: {
      slug: { type: "STRING" },
      title: { type: "STRING" },
      dek: { type: "STRING" },
      tags: { type: "ARRAY", items: { type: "STRING" } },
      sections: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            h: { type: "STRING" },
            p: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["h", "p"]
        }
      },
      sourceIndexes: { type: "ARRAY", items: { type: "INTEGER" } }
    },
    required: ["slug", "title", "dek", "tags", "sections", "sourceIndexes"]
  };

  const prompt = `You are a senior editor at Beat Six (a GTA 6 guide and meta site).
Using ONLY the verified recent sources below, write ONE sharp, timely, original GTA 6 briefing article synthesizing the biggest current developments for players.
Sources (0-indexed):
${JSON.stringify(sourcePool)}

Rules:
- Cite at least 3 distinct sources via sourceIndexes.
- No semicolons or em-dashes in title or dek.
- Write 3 to 4 sections, each with a clear heading (h) and 2 concise, practical paragraphs (p).
- Never mention AI or automated systems.`;

  const draft = await callGeminiJson("CitedArticle", prompt, schema);
  if (!draft || !draft.title || !Array.isArray(draft.sections) || draft.sections.length < 2) {
    return false;
  }

  const pickedSources = (draft.sourceIndexes || []).map(i => sourcePool[i]).filter(Boolean);
  if (pickedSources.length < 3) pickedSources.push(...sourcePool.slice(0, 3));

  const uniqueSources = [];
  const seenUrls = new Set();
  for (const s of pickedSources) {
    if (seenUrls.has(s.url)) continue;
    seenUrls.add(s.url);
    uniqueSources.push({ title: s.title, publisher: s.source, url: s.url, date: s.date });
  }

  const slug = slugify(draft.slug || draft.title);
  if (existingPosts.some(p => p.slug === slug)) return false;

  const post = {
    slug,
    title: cleanHeadline(draft.title),
    dek: cleanHeadline(draft.dek || ""),
    author: "Beat Six Staff",
    published: today,
    updated: today,
    tags: Array.isArray(draft.tags) && draft.tags.length ? draft.tags.slice(0, 3) : ["Meta", "News"],
    sections: draft.sections.map(sec => ({
      h: cleanHeadline(sec.h || ""),
      p: (sec.p || []).map(para => decodeHtml(para))
    })),
    sources: uniqueSources.slice(0, 6)
  };

  data.posts = [post, ...existingPosts].slice(0, MAX_POSTS_ITEMS);
  console.log(`[Articles] Published new cited article: "${post.title}" (${post.sources.length} sources)`);
  return true;
}

async function main() {
  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(`data.json not found at ${DATA_PATH}`);
  }

  console.log("=== Beat Six Balanced Meta & Content Refresh Starting ===");
  console.log(`[Config] GEMINI_API_KEY: ${GEMINI_API_KEY ? "SET (len=" + GEMINI_API_KEY.length + ")" : "MISSING"} | YOUTUBE_API_KEY: ${YOUTUBE_API_KEY ? "SET" : "USING ZERO-KEY FALLBACK"}`);

  await discoverWorkingModels();

  const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  data.meta = data.meta || {};
  data.categories = data.categories || {};
  for (const c of CATEGORY_KEYS) {
    data.categories[c] = Array.isArray(data.categories[c]) ? data.categories[c] : [];
  }
  data.news = Array.isArray(data.news) ? data.news : [];
  data.posts = Array.isArray(data.posts) ? data.posts : [];
  data.guides = Array.isArray(data.guides) ? data.guides : [];
  data.lists = Array.isArray(data.lists) ? data.lists : [];
  data.changelog = Array.isArray(data.changelog) ? data.changelog : [];

  const beforeNewsCount = data.news.length;
  const today = todayIso();

  // 1. Auto-fix existing typos (e.g. "Gotti Cheetah" -> "Grotti Cheetah") & merge duplicates (e.g. "Vault Jobs" + "Vault Raids")
  let totalTyposFixed = 0;
  let totalDuplicatesMerged = 0;
  for (const catKey of CATEGORY_KEYS) {
    const cleaned = cleanAndDeduplicateCategory(catKey, data.categories[catKey]);
    data.categories[catKey] = cleaned.items;
    totalTyposFixed += cleaned.fixedNames;
    totalDuplicatesMerged += cleaned.mergedCount;
    if (cleaned.fixedNames > 0 || cleaned.mergedCount > 0) {
      console.log(`[Cleanup:${catKey}] Fixed ${cleaned.fixedNames} typos, merged ${cleaned.mergedCount} duplicates.`);
    }
  }

  // 2. Auto-scrub existing data.news
  let scrubbedCount = 0;
  for (const n of data.news) {
    const origBody = n.body || "";
    const cleanedBody = cleanBodyText(origBody, n.title, n.source);
    if (cleanedBody !== origBody) {
      n.body = cleanedBody;
      scrubbedCount++;
    }
    n.title = cleanHeadline(n.title || "");

    if (!n.added || n.added > today) n.added = daysAgoIso(2);
    if (BOILERPLATE_IDS.has(n.id) || /ps5 system update|deadzone|how to save/i.test(n.title || "")) {
      n.added = daysAgoIso(14);
    }
  }

  // 3. Fetch Online Articles & YouTube videos for all 4 categories
  const [articleData, ytCars, ytWeapons, ytMoney, ytGear] = await Promise.all([
    fetchAllOnlineArticles(),
    fetchYouTubeForCategory("cars"),
    fetchYouTubeForCategory("weapons"),
    fetchYouTubeForCategory("money"),
    fetchYouTubeForCategory("gear")
  ]);

  const ytByCategory = { cars: ytCars, weapons: ytWeapons, money: ytMoney, gear: ytGear };
  const allYt = [...ytCars, ...ytWeapons, ...ytMoney, ...ytGear];

  // 4. Deduplicate fresh news candidates
  const existingUrls = new Set(data.news.map(n => safeUrl(n.url)).filter(Boolean));
  const candidates = [];
  for (const item of articleData.general) {
    if (existingUrls.has(item.url)) continue;
    if (data.news.some(n => isSimilarHeadline(n.title, item.title))) continue;
    if (candidates.some(c => c.url === item.url || isSimilarHeadline(c.title, item.title))) continue;
    candidates.push(item);
  }
  console.log(`[News] Unique new candidates after deduplication: ${candidates.length}`);

  // 5. Call 1: Enrich fresh news
  let processedNew = [];
  if (candidates.length > 0) {
    const geminiEnriched = await enrichNewsWithGemini(candidates);
    if (geminiEnriched && geminiEnriched.length > 0) {
      processedNew = geminiEnriched;
    } else {
      processedNew = candidates.slice(0, 45).map(item => ({
        id: slugify(item.title),
        title: item.title,
        body: item.body || `Latest GTA 6 coverage from ${item.source}.`,
        cat: heuristicCategory(item.title, item.body),
        status: "reported",
        source: item.source,
        url: item.url,
        added: item.added,
        heroScore: heuristicHeroScore(item)
      }));
    }
  }

  const mergedNews = [...processedNew, ...data.news];
  for (const n of mergedNews) {
    if (!Number.isFinite(n.heroScore)) n.heroScore = heuristicHeroScore(n);
  }
  const heroPool = mergedNews.filter(n => !BOILERPLATE_IDS.has(n.id) && !/ps5 system update/i.test(n.title || ""));
  if (heroPool.length > 0) {
    heroPool.sort((a, b) => (b.heroScore - a.heroScore) || (b.added || "").localeCompare(a.added || ""));
    heroPool[0].added = today;
    heroPool[0].heroScore = 999;
  }
  mergedNews.sort((a, b) => {
    const dateDiff = (b.added || "").localeCompare(a.added || "");
    if (dateDiff !== 0) return dateDiff;
    return (b.heroScore || 0) - (a.heroScore || 0);
  });
  data.news = mergedNews.slice(0, MAX_NEWS_ITEMS).map(({ heroScore, ...cleanItem }) => cleanItem);

  // 6. Calls 2-5: Expand Meta categories in SMALLEST-FIRST order so Gear (5 items) gets top priority
  let totalMetaItemsAdded = 0;
  let totalMetaRanksAdded = 0;
  const prioritizedCategories = [...CATEGORY_KEYS].sort(
    (a, b) => data.categories[a].length - data.categories[b].length
  );
  console.log(`[Meta] Category priority order (smallest first): ${prioritizedCategories.join(" -> ")}`);

  for (const catKey of prioritizedCategories) {
    const webPool = [
      ...articleData.byCategory[catKey],
      ...articleData.general.slice(0, 12)
    ];
    const { addedItems, addedRanks } = await expandSingleMetaCategory(
      data,
      catKey,
      ytByCategory[catKey],
      webPool
    );
    totalMetaItemsAdded += addedItems;
    totalMetaRanksAdded += addedRanks;
  }

  // 7. Build unified verified source pool for Guides, Lists, and Tracked Sources
  const seenPoolUrls = new Set();
  const verifiedSourcePool = [];
  const rawPool = [
    ...allYt,
    ...articleData.byCategory.gear.slice(0, 6),
    ...articleData.byCategory.cars.slice(0, 6),
    ...articleData.byCategory.weapons.slice(0, 6),
    ...articleData.byCategory.money.slice(0, 6),
    ...data.news.slice(0, 20).map(n => ({
      title: n.title,
      body: n.body,
      source: n.source,
      url: n.url,
      kind: /youtube\.com|youtu\.be/i.test(n.url || "") ? "youtube" : "web",
      added: n.added
    }))
  ];
  for (const s of rawPool) {
    const u = safeUrl(s.url);
    if (!u || seenPoolUrls.has(u)) continue;
    seenPoolUrls.add(u);
    verifiedSourcePool.push({ ...s, url: u });
  }

  // 8. Calls 6, 7, 8: Guides, Discover Lists, and Cited Article
  const guidesAdded = await expandGuidesWithGemini(data, verifiedSourcePool);
  const listsAdded = await expandDiscoverListsWithGemini(data, verifiedSourcePool);
  const publishedArticle = await maybeGenerateCitedArticle(data, data.news);

  // 9. Update tracked sources list for the Methodology page
  const trackedMap = new Map();
  for (const s of (data.meta.sourcesTracked || [])) {
    if (s && s.name) trackedMap.set(s.name.toLowerCase(), s);
  }
  for (const s of verifiedSourcePool.slice(0, 35)) {
    if (!s.source) continue;
    const key = s.source.toLowerCase();
    if (!trackedMap.has(key)) {
      trackedMap.set(key, { name: s.source, url: s.url, kind: s.kind || "web" });
    }
  }
  data.meta.sourcesTracked = Array.from(trackedMap.values()).slice(0, 50);

  // 10. Update metadata & changelog
  data.meta.updated = today;
  const summaryParts = [];
  if (processedNew.length > 0) summaryParts.push(`+${processedNew.length} news stories`);
  if (totalMetaItemsAdded > 0 || totalMetaRanksAdded > 0) {
    summaryParts.push(`+${totalMetaItemsAdded} Meta items & +${totalMetaRanksAdded} critic rankings`);
  }
  if (totalTyposFixed > 0 || totalDuplicatesMerged > 0) {
    summaryParts.push(`fixed ${totalTyposFixed} typos & merged ${totalDuplicatesMerged} duplicates`);
  }
  if (guidesAdded > 0) summaryParts.push(`+${guidesAdded} guides`);
  if (listsAdded > 0) summaryParts.push(`+${listsAdded} Discover lists`);
  if (publishedArticle) summaryParts.push("1 cited article");

  if (summaryParts.length > 0 || scrubbedCount > 0) {
    data.changelog.unshift({
      date: today,
      text: summaryParts.length
        ? `Daily refresh: ${summaryParts.join(", ")}.`
        : `Cleaned HTML formatting across ${scrubbedCount} news summaries.`
    });
    data.changelog = data.changelog.slice(0, 40);
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");

  console.log("=== Refresh Complete ===");
  console.log(`Gemini calls: ${geminiCallCount} attempted | ${geminiSuccessCount} succeeded | ${geminiFailCount} failed`);
  if (geminiLastError) {
    console.log(`Last Gemini error: ${geminiLastError}`);
  }
  console.log(`Cleanup: ${totalTyposFixed} typos fixed | ${totalDuplicatesMerged} duplicates merged`);
  console.log(`News: ${beforeNewsCount} -> ${data.news.length} (+${processedNew.length} new, ${scrubbedCount} scrubbed)`);
  console.log(`Primary Hero Lead (#1): "${data.news[0]?.title || "none"}" (${data.news[0]?.source || ""})`);
  for (const c of CATEGORY_KEYS) {
    const d = getTierDistribution(data.categories[c]);
    console.log(`Meta [${c}]: ${data.categories[c].length} total (S=${d.S}, A=${d.A}, B=${d.B}, C=${d.C})`);
  }
  console.log(`Search Guides: ${data.guides.length} | Discover Lists: ${data.lists.length} | Articles: ${data.posts.length}`);
}

main().catch(err => {
  console.error("FATAL REFRESH ERROR:", err);
  process.exit(1);
});
