// scripts/daily-refresh.mjs
// Beat Six Full-Site Content Aggregator (Free-Tier Safe: max 5 Gemini calls/day)
// Strictly updates data.json only; never touches index.html.

import fs from "node:fs";
import path from "node:path";

const DATA_PATH = path.resolve(process.cwd(), "data.json");
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || "").trim();

const MODEL_CANDIDATES = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
];

const MAX_NEWS_ITEMS = 120;
const MAX_POSTS_ITEMS = 40;
const MAX_GUIDES_ITEMS = 30;
const MAX_LISTS_ITEMS = 12;
const MAX_ITEMS_PER_CATEGORY = 16;

const VALID_NEWS_CATS = new Set(["launch", "tips", "eggs", "weapons", "vehicles", "items", "world"]);
const VALID_STATUSES = new Set(["confirmed", "reported", "disputed"]);
const CATEGORY_KEYS = ["cars", "weapons", "money", "gear"];

const GAMING_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" }
];

// Live RSS sources: Google News GTA 6 beats + major gaming outlets
const RSS_FEEDS = [
  {
    name: "Google News (GTA 6 Latest)",
    url: "https://news.google.com/rss/search?q=%22GTA+6%22+OR+%22Grand+Theft+Auto+VI%22+when:14d&hl=en-US&gl=US&ceid=US:en",
    requireGtaMatch: false
  },
  {
    name: "Google News (GTA 6 Guides & Tips)",
    url: "https://news.google.com/rss/search?q=%22GTA+6%22+(guide+OR+tips+OR+money+OR+weapons+OR+cars+OR+best)+when:30d&hl=en-US&gl=US&ceid=US:en",
    requireGtaMatch: false
  },
  {
    name: "Google News (GTA 6 Patches & Secrets)",
    url: "https://news.google.com/rss/search?q=%22GTA+6%22+(patch+OR+update+OR+easter+egg+OR+secret+OR+Leonida+OR+Vice+City)+when:30d&hl=en-US&gl=US&ceid=US:en",
    requireGtaMatch: false
  },
  {
    name: "Google News (GTA 6 Vehicles & Combat)",
    url: "https://news.google.com/rss/search?q=%22Grand+Theft+Auto+VI%22+(vehicle+OR+supercar+OR+weapon+OR+heist+OR+meta)+when:30d&hl=en-US&gl=US&ceid=US:en",
    requireGtaMatch: false
  },
  { name: "IGN", url: "https://feeds.feedburner.com/ign/games-all", requireGtaMatch: true },
  { name: "Eurogamer", url: "https://www.eurogamer.net/feed", requireGtaMatch: true },
  { name: "VGC", url: "https://www.videogameschronicle.com/feed/", requireGtaMatch: true },
  { name: "PC Gamer", url: "https://www.pcgamer.com/rss/", requireGtaMatch: true },
  { name: "GamesRadar", url: "https://www.gamesradar.com/rss/", requireGtaMatch: true },
  { name: "Dexerto", url: "https://www.dexerto.com/feed/", requireGtaMatch: true }
];

const GTA_REGEX = /\b(gta\s*6|gta\s*vi|grand\s+theft\s+auto\s*(6|vi)|leonida|vice\s+city|rockstar\s+games)\b/i;

const BOILERPLATE_IDS = new Set([
  "ps5-system-update",
  "saving",
  "settings-deadzone"
]);

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
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// Permanently fixes Google News double-encoded HTML (<a href="https://news.google.com/...">)
function decodeHtml(str) {
  if (!str) return "";
  let s = String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

  // Decode entities FIRST (twice in case of double encoding) so &lt;a href=...&gt; becomes real tags
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

  // Now strip all HTML tags, truncated unclosed tags, and raw URLs
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
  // Google News descriptions often just repeat "Headline Publisher"
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

function extractTag(block, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
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
    link = safeUrl(decodeHtml(link).length ? link.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "");
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
    if (title.length < 18) continue;

    results.push({
      title,
      body,
      source: publisher || "Gaming Press",
      url: link,
      kind: "web",
      added: parseDateIso(rawPubDate)
    });
  }
  return results;
}

async function fetchAllRssNews() {
  const collected = [];
  for (const feed of RSS_FEEDS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const resp = await fetch(feed.url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; BeatSixBot/1.0; +https://gta6-meta-center.vercel.app)",
          "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
        }
      });
      clearTimeout(timer);

      if (!resp.ok) {
        console.warn(`[RSS] ${feed.name} returned HTTP ${resp.status}`);
        continue;
      }
      const xml = await resp.text();
      const parsed = parseRssXml(xml, feed);
      console.log(`[RSS] ${feed.name}: ${parsed.length} matching stories`);
      collected.push(...parsed);
    } catch (err) {
      console.warn(`[RSS] ${feed.name} failed: ${err.message}`);
    }
  }
  return collected;
}

// Optional zero-cost YouTube discovery (uses ~200 of 10,000 daily free quota units when YOUTUBE_API_KEY is set)
async function fetchYouTubeGuides() {
  if (!YOUTUBE_API_KEY) return [];
  const queries = [
    "GTA 6 fastest cars best vehicles tested",
    "GTA 6 best weapons money guide tips"
  ];
  const videos = [];
  const publishedAfter = new Date(Date.now() - 21 * 86400000).toISOString();

  for (const q of queries) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=relevance&maxResults=6&publishedAfter=${encodeURIComponent(publishedAfter)}&q=${encodeURIComponent(q)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const json = await resp.json();
      for (const item of (json.items || [])) {
        const vidId = item.id?.videoId;
        const snip = item.snippet;
        if (!vidId || !snip?.title) continue;
        videos.push({
          title: cleanHeadline(snip.title),
          body: cleanBodyText(snip.description || "", snip.title, snip.channelTitle),
          source: snip.channelTitle || "YouTube Creator",
          url: `https://www.youtube.com/watch?v=${vidId}`,
          kind: "youtube",
          added: parseDateIso(snip.publishedAt)
        });
      }
    } catch (err) {
      console.warn(`[YouTube] Query failed: ${err.message}`);
    }
  }
  console.log(`[YouTube] Discovered ${videos.length} recent creator videos`);
  return videos;
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

async function callGeminiJson(promptText, responseSchema) {
  if (!GEMINI_API_KEY) return null;
  let lastErr = null;

  for (const modelId of MODEL_CANDIDATES) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const body = {
        contents: [{ parts: [{ text: promptText }] }],
        safetySettings: GAMING_SAFETY_SETTINGS,
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.3
        }
      };
      if (responseSchema) body.generationConfig.responseSchema = responseSchema;

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const json = await resp.json();
      if (!resp.ok || json.error) {
        lastErr = new Error(`${modelId} HTTP ${resp.status}: ${json.error?.message || "Unknown error"}`);
        continue;
      }

      const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        lastErr = new Error(`${modelId} returned empty candidate`);
        continue;
      }
      return JSON.parse(rawText);
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn(`[Gemini] All models failed: ${lastErr?.message || "unknown"}`);
  return null;
}

// CALL 1: Enrich & rank fresh RSS news items
async function enrichNewsWithGemini(candidates) {
  if (!GEMINI_API_KEY || !candidates.length) return null;

  const batch = candidates.slice(0, 40).map((c, idx) => ({
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

For each item:
- Set keep=false ONLY if it is pure off-topic spam, non-GTA-6, or obvious clickbait rumor garbage.
- Clean up title if needed (no semicolons, no em-dashes).
- Write a crisp, plain-text 1-2 sentence summary (100-190 chars) with NO HTML tags and NO URLs.
- Assign cat strictly from: "launch", "tips", "eggs", "weapons", "vehicles", "items", "world".
- Assign status strictly from: "confirmed", "reported", "disputed".
- Assign heroScore 1-100 based on front-page value for GTA 6 players right now.`;

  const res = await callGeminiJson(prompt, schema);
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

// CALL 2: Expand Meta Tier Lists (cars, weapons, money, gear) with verified source citations
async function expandMetaCategoriesWithGemini(data, sourcePool) {
  if (!GEMINI_API_KEY || sourcePool.length < 3) return 0;

  const existingSummary = {};
  for (const c of CATEGORY_KEYS) {
    existingSummary[c] = (data.categories[c] || []).map(i => ({
      id: i.id,
      name: i.name,
      ranksCount: (i.ranks || []).length
    }));
  }

  const compactSources = sourcePool.slice(0, 24).map((s, idx) => ({
    idx,
    title: s.title,
    body: s.body,
    source: s.source,
    kind: s.kind || "web"
  }));

  const schema = {
    type: "OBJECT",
    properties: {
      newItems: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            category: { type: "STRING" },
            name: { type: "STRING" },
            type: { type: "STRING" },
            blurb: { type: "STRING" },
            get: { type: "STRING" },
            factKey1: { type: "STRING" },
            factVal1: { type: "STRING" },
            factKey2: { type: "STRING" },
            factVal2: { type: "STRING" },
            rank: { type: "INTEGER" },
            quote: { type: "STRING" },
            sourceIdx: { type: "INTEGER" }
          },
          required: ["category", "name", "type", "blurb", "get", "rank", "quote", "sourceIdx"]
        }
      },
      extraRanks: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            category: { type: "STRING" },
            itemId: { type: "STRING" },
            rank: { type: "INTEGER" },
            quote: { type: "STRING" },
            sourceIdx: { type: "INTEGER" }
          },
          required: ["category", "itemId", "rank", "quote", "sourceIdx"]
        }
      }
    },
    required: ["newItems", "extraRanks"]
  };

  const prompt = `Context: Benign video game guide curation for Beat Six (a GTA 6 meta site).
Current tracked Meta items by category:
${JSON.stringify(existingSummary)}

Recent verified GTA 6 articles and videos (0-indexed):
${JSON.stringify(compactSources)}

Task:
1. In newItems, propose 4 to 8 notable GTA 6 items (1-2 per category across "cars", "weapons", "money", "gear") that are NOT already in the existing list and are relevant to current GTA 6 gameplay.
   - For "cars": include factKey1="Top speed" (e.g. "134 mph") and factKey2="Price" or "Class".
   - For "weapons": include factKey1="Damage" and factKey2="Best use".
   - For "money": include factKey1="Payout" (e.g. "$250,000 - $400,000") and factKey2="Time".
   - For "gear": include factKey1="Effect" and factKey2="Unlock".
   - Assign a realistic rank (1-8), a concise 1-sentence testing quote, and the most relevant sourceIdx from the list above.
2. In extraRanks, add 3 to 6 fresh critic rankings for existing itemIds that have fewer than 3 ranks, citing a relevant sourceIdx.`;

  const res = await callGeminiJson(prompt, schema);
  if (!res) return 0;

  let changes = 0;

  for (const item of (res.newItems || [])) {
    if (!CATEGORY_KEYS.includes(item.category)) continue;
    const list = data.categories[item.category] || [];
    if (list.length >= MAX_ITEMS_PER_CATEGORY) continue;

    const id = slugify(item.name);
    if (!id || list.some(x => x.id === id || x.name.toLowerCase() === item.name.toLowerCase())) continue;

    const src = sourcePool[item.sourceIdx] || sourcePool[0];
    if (!src) continue;

    const facts = {};
    if (item.factKey1 && item.factVal1) facts[item.factKey1] = item.factVal1;
    if (item.factKey2 && item.factVal2) facts[item.factKey2] = item.factVal2;

    list.push({
      id,
      name: cleanHeadline(item.name),
      type: item.type || "Standard",
      blurb: decodeHtml(item.blurb || "").slice(0, 220),
      get: decodeHtml(item.get || "").slice(0, 140),
      facts,
      ranks: [
        {
          source: src.source,
          kind: src.kind || "web",
          rank: Math.min(10, Math.max(1, Number(item.rank) || 3)),
          quote: decodeHtml(item.quote || "").slice(0, 180),
          url: safeUrl(src.url)
        }
      ]
    });
    data.categories[item.category] = list;
    changes++;
  }

  for (const r of (res.extraRanks || [])) {
    if (!CATEGORY_KEYS.includes(r.category)) continue;
    const list = data.categories[r.category] || [];
    const target = list.find(x => x.id === r.itemId);
    const src = sourcePool[r.sourceIdx];
    if (!target || !src) continue;

    target.ranks = target.ranks || [];
    if (target.ranks.some(existing => existing.source.toLowerCase() === src.source.toLowerCase())) continue;

    target.ranks.push({
      source: src.source,
      kind: src.kind || "web",
      rank: Math.min(10, Math.max(1, Number(r.rank) || 3)),
      quote: decodeHtml(r.quote || "").slice(0, 180),
      url: safeUrl(src.url)
    });
    changes++;
  }

  console.log(`[Meta] Applied ${changes} catalog/ranking updates across cars, weapons, money, gear.`);
  return changes;
}

// CALL 3: Expand Search How-To Guides (data.guides)
async function expandGuidesWithGemini(data, sourcePool) {
  if (!GEMINI_API_KEY || sourcePool.length < 3) return 0;

  const existingGuides = Array.isArray(data.guides) ? data.guides : [];
  if (existingGuides.length >= MAX_GUIDES_ITEMS) return 0;

  const existingTitles = existingGuides.map(g => g.title);
  const compactSources = sourcePool.slice(0, 20).map((s, idx) => ({
    idx,
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

Recent verified GTA 6 sources (0-indexed):
${JSON.stringify(compactSources)}

Create 2 to 3 practical, high-demand GTA 6 how-to guides (for example: leveling stats, making early cash, combat/aiming tips, vehicle theft, map/mechanics, settings) inspired by the sources above.
Rules:
- Clear question or action title (no semicolons or em-dashes).
- 1-2 sentence summary (plain text, no HTML/URLs).
- 4 to 6 concrete, actionable steps.
- Cite 1 to 3 relevant sourceIndexes from the list above.`;

  const res = await callGeminiJson(prompt, schema);
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

// CALL 4: Expand Discover Checklists & Ranked Lists (data.lists)
async function expandDiscoverListsWithGemini(data, sourcePool) {
  if (!GEMINI_API_KEY || sourcePool.length < 3) return 0;

  const existingLists = Array.isArray(data.lists) ? data.lists : [];
  if (existingLists.length >= MAX_LISTS_ITEMS) return 0;

  const existingIds = existingLists.map(l => ({ id: l.id, title: l.title }));
  const metaRefs = [];
  for (const c of CATEGORY_KEYS) {
    for (const it of (data.categories[c] || []).slice(0, 6)) {
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

Create 2 fresh, genuinely useful Discover lists (1 "checklist" and 1 "ranked") for GTA 6 players (for example: "First 10 hours progression checklist", "Best solo money routine", "Essential Vice City exploration checklist", "Top heist prep loadout").
Rules:
- Each list must have 5 to 7 concrete entries.
- kind must be strictly "checklist" or "ranked".
- stage should be concise (e.g., "Early game", "Mid game", "Money", "Combat", "Exploration", "Vehicles").
- Only use "ref" if it exactly matches one of the available Beat Six Meta refs above; otherwise leave "ref" empty.
- No semicolons, no em-dashes, no HTML tags, no raw URLs.`;

  const res = await callGeminiJson(prompt, schema);
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

// CALL 5: Publish 1 multi-source cited article per day (data.posts)
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

  const draft = await callGeminiJson(prompt, schema);
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

  // 1. Auto-scrub existing data.news (fixes overflowing <a href="https://news.google.com/..."> immediately)
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
  if (scrubbedCount > 0) {
    console.log(`[Cleanup] Scrubbed raw HTML/URLs from ${scrubbedCount} existing news items.`);
  }

  // 2. Fetch live RSS stories + optional YouTube creator guides
  console.log("=== Beat Six Daily Content Refresh Starting ===");
  const [rawRss, ytVideos] = await Promise.all([fetchAllRssNews(), fetchYouTubeGuides()]);
  console.log(`[RSS] Total raw matched items fetched: ${rawRss.length}`);

  const existingUrls = new Set(data.news.map(n => safeUrl(n.url)).filter(Boolean));
  const candidates = [];

  for (const item of rawRss) {
    if (existingUrls.has(item.url)) continue;
    if (data.news.some(n => isSimilarHeadline(n.title, item.title))) continue;
    if (candidates.some(c => c.url === item.url || isSimilarHeadline(c.title, item.title))) continue;
    candidates.push(item);
  }
  console.log(`[RSS] Unique new candidates after deduplication: ${candidates.length}`);

  // 3. Call 1: Enrich fresh news with Gemini (or clean deterministic fallback)
  let processedNew = [];
  if (candidates.length > 0) {
    const geminiEnriched = await enrichNewsWithGemini(candidates);
    if (geminiEnriched && geminiEnriched.length > 0) {
      console.log(`[Gemini] Enriched and approved ${geminiEnriched.length} stories.`);
      processedNew = geminiEnriched;
    } else {
      console.log("[Fallback] Using deterministic categorization for live RSS stories.");
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

  // 4. Merge news, pick strongest timely Hero Lead (#1), and sort cleanly
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

  // Build unified verified source pool (fresh news + YouTube creator videos) for Meta, Guides, Lists & Articles
  const verifiedSourcePool = [
    ...ytVideos,
    ...data.news.slice(0, 30).map(n => ({
      title: n.title,
      body: n.body,
      source: n.source,
      url: n.url,
      kind: /youtube\.com|youtu\.be/i.test(n.url || "") ? "youtube" : "web",
      added: n.added
    }))
  ].filter(s => safeUrl(s.url));

  // 5. Calls 2, 3, 4, 5: Expand Meta Tier Lists, Search Guides, Discover Checklists, and Articles
  const metaUpdates = await expandMetaCategoriesWithGemini(data, verifiedSourcePool);
  const guidesAdded = await expandGuidesWithGemini(data, verifiedSourcePool);
  const listsAdded = await expandDiscoverListsWithGemini(data, verifiedSourcePool);
  const publishedArticle = await maybeGenerateCitedArticle(data, data.news);

  // 6. Update tracked sources list for the Methodology page
  const trackedMap = new Map();
  for (const s of (data.meta.sourcesTracked || [])) {
    if (s && s.name) trackedMap.set(s.name.toLowerCase(), s);
  }
  for (const s of verifiedSourcePool.slice(0, 25)) {
    if (!s.source) continue;
    const key = s.source.toLowerCase();
    if (!trackedMap.has(key)) {
      trackedMap.set(key, { name: s.source, url: s.url, kind: s.kind || "web" });
    }
  }
  data.meta.sourcesTracked = Array.from(trackedMap.values()).slice(0, 40);

  // 7. Update metadata and changelog
  data.meta.updated = today;
  const summaryParts = [];
  if (processedNew.length > 0) summaryParts.push(`+${processedNew.length} news stories`);
  if (metaUpdates > 0) summaryParts.push(`${metaUpdates} Meta ranking updates`);
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
  console.log(`News: ${beforeNewsCount} -> ${data.news.length} (+${processedNew.length} new, ${scrubbedCount} scrubbed)`);
  console.log(`Primary Hero Lead (#1): "${data.news[0]?.title || "none"}" (${data.news[0]?.source || ""})`);
  console.log(`Meta totals -> Cars: ${data.categories.cars.length}, Weapons: ${data.categories.weapons.length}, Money: ${data.categories.money.length}, Gear: ${data.categories.gear.length}`);
  console.log(`Search Guides: ${data.guides.length} | Discover Lists: ${data.lists.length} | Articles: ${data.posts.length}`);
}

main().catch(err => {
  console.error("FATAL REFRESH ERROR:", err);
  process.exit(1);
});
