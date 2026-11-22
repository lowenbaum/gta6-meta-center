// scripts/daily-refresh.mjs
// Beat Six Backend Content Aggregator: Live RSS Ingestion + Gemini Editorial Enrichment
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
const VALID_NEWS_CATS = new Set(["launch", "tips", "eggs", "weapons", "vehicles", "items", "world"]);
const VALID_STATUSES = new Set(["confirmed", "reported", "disputed"]);

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

function decodeHtml(str) {
  if (!str) return "";
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHeadline(title) {
  let t = decodeHtml(title || "");
  // Strip trailing " - Publisher Name" that Google News appends
  t = t.replace(/\s+-\s+[^-]{2,45}$/, "").trim();
  // Match Beat Six house style (no semicolons or em/en dashes)
  t = t
    .replace(/\s*;\s*/g, ", ")
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/\s+--\s+/g, ", ")
    .replace(/,\s*,/g, ",")
    .trim();
  return t;
}

function safeUrl(u) {
  return typeof u === "string" && /^https:\/\//i.test(u.trim()) ? u.trim() : "";
}

function parseDateIso(raw) {
  if (!raw) return todayIso();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return todayIso();
  const iso = d.toISOString().slice(0, 10);
  // Clamp any future-dated timestamp to today
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
  const ratio = overlap / Math.min(wa.size, wb.size);
  return ratio >= 0.65;
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
    link = safeUrl(decodeHtml(link));
    if (!rawTitle || !link) continue;

    const fullText = `${rawTitle} ${rawDesc}`;
    if (feedMeta.requireGtaMatch && !GTA_REGEX.test(fullText)) continue;

    // Extract publisher from Google News "<source>" or trailing " - Publisher"
    let publisher = decodeHtml(rawSource);
    if (!publisher) {
      const dashPub = decodeHtml(rawTitle).match(/\s+-\s+([^-]{2,45})$/);
      publisher = dashPub ? dashPub[1].trim() : feedMeta.name.replace(/\s*\(.*?\)/g, "");
    }

    const title = cleanHeadline(rawTitle);
    const body = decodeHtml(rawDesc).slice(0, 260);
    if (title.length < 18) continue;

    results.push({
      title,
      body: body && body.toLowerCase() !== title.toLowerCase() ? body : "",
      source: publisher || "Gaming Press",
      url: link,
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
  const ageDays = Math.max(0, Math.round((Date.now() - new Date(item.added + "T12:00:00Z").getTime()) / 86400000));
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
- Set keep=false ONLY if it is pure off-topic spam, non-GTA-6, or obvious clickbait rumor garbage. Keep legitimate news, guides, tips, patches, leaks/reports, economy/vehicle/weapon discussions, and Rockstar updates.
- Clean up title if needed (no semicolons, no em-dashes).
- Write a concise, informative 1-2 sentence body summary (100-200 chars) explaining why GTA 6 players care.
- Assign cat strictly from: "launch", "tips", "eggs", "weapons", "vehicles", "items", "world".
- Assign status strictly from: "confirmed", "reported", "disputed".
- Assign heroScore from 1 to 100 based on how timely, relevant, and front-page-worthy it is for GTA 6 players right now (major Rockstar announcements, meta shifts, big patches, and standout guides score 85-100; routine firmware/install boilerplate scores under 30).`;

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
      body: (row.body || orig.body || "").trim(),
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

  if (sourcePool.length < 3) {
    console.log("[Articles] Fewer than 3 fresh sources available; skipping article generation.");
    return false;
  }

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
- Cite at least 3 distinct sources from the list above via sourceIndexes.
- No semicolons or em-dashes in title or dek.
- Write 3 to 4 sections, each with a clear heading (h) and 2 concise, practical paragraphs (p).
- Never mention AI or automated systems.`;

  const draft = await callGeminiJson(prompt, schema);
  if (!draft || !draft.title || !Array.isArray(draft.sections) || draft.sections.length < 2) {
    return false;
  }

  const pickedSources = (draft.sourceIndexes || [])
    .map(i => sourcePool[i])
    .filter(Boolean);

  if (pickedSources.length < 3) {
    pickedSources.push(...sourcePool.slice(0, 3));
  }

  const uniqueSources = [];
  const seenUrls = new Set();
  for (const s of pickedSources) {
    if (seenUrls.has(s.url)) continue;
    seenUrls.add(s.url);
    uniqueSources.push({
      title: s.title,
      publisher: s.source,
      url: s.url,
      date: s.date
    });
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
    sections: draft.sections,
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
  data.news = Array.isArray(data.news) ? data.news : [];
  data.posts = Array.isArray(data.posts) ? data.posts : [];
  data.changelog = Array.isArray(data.changelog) ? data.changelog : [];

  const beforeCount = data.news.length;
  const today = todayIso();

  // 1. Normalize any future-dated legacy items and demote launch boilerplate so they never hog #1 Hero
  for (const n of data.news) {
    if (!n.added || n.added > today) {
      n.added = daysAgoIso(2);
    }
    if (BOILERPLATE_IDS.has(n.id) || /ps5 system update|deadzone|how to save/i.test(n.title || "")) {
      n.added = daysAgoIso(14);
    }
  }

  // 2. Fetch live GTA 6 RSS stories
  console.log("=== Beat Six Daily Content Refresh Starting ===");
  const rawRss = await fetchAllRssNews();
  console.log(`[RSS] Total raw matched items fetched: ${rawRss.length}`);

  if (rawRss.length === 0) {
    throw new Error("RSS ingestion returned 0 items. Check network access or RSS feed URLs.");
  }

  // 3. Deduplicate raw RSS items against each other AND against existing data.news
  const existingUrls = new Set(data.news.map(n => safeUrl(n.url)).filter(Boolean));
  const candidates = [];

  for (const item of rawRss) {
    if (existingUrls.has(item.url)) continue;
    if (data.news.some(n => isSimilarHeadline(n.title, item.title))) continue;
    if (candidates.some(c => c.url === item.url || isSimilarHeadline(c.title, item.title))) continue;
    candidates.push(item);
  }
  console.log(`[RSS] Unique new candidates after deduplication: ${candidates.length}`);

  // 4. Enrich with Gemini if API key is configured; otherwise use clean heuristic fallback
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

  // 5. Merge, pick the strongest timely Hero Lead for index 0, and sort cleanly
  const mergedNews = [...processedNew, ...data.news];

  // Ensure every item has a heroScore for tie-breaking within the same date
  for (const n of mergedNews) {
    if (!Number.isFinite(n.heroScore)) n.heroScore = heuristicHeroScore(n);
  }

  // Pick the best timely hero candidate from the most recent stories and stamp it with today's date
  // so index.html's (b.added).localeCompare(a.added) ALWAYS keeps it in the #1 .lead Hero card
  const heroPool = mergedNews.filter(n => !BOILERPLATE_IDS.has(n.id) && !/ps5 system update/i.test(n.title || ""));
  if (heroPool.length > 0) {
    heroPool.sort((a, b) => (b.heroScore - a.heroScore) || (b.added || "").localeCompare(a.added || ""));
    const hero = heroPool[0];
    hero.added = today;
    hero.heroScore = 999;
  }

  // Sort by date descending, then heroScore descending
  mergedNews.sort((a, b) => {
    const dateDiff = (b.added || "").localeCompare(a.added || "");
    if (dateDiff !== 0) return dateDiff;
    return (b.heroScore || 0) - (a.heroScore || 0);
  });

  // Strip internal heroScore before writing clean data.json
  data.news = mergedNews.slice(0, MAX_NEWS_ITEMS).map(({ heroScore, ...cleanItem }) => cleanItem);

  // 6. Generate a fresh multi-source cited article if eligible
  const publishedArticle = await maybeGenerateCitedArticle(data, data.news);

  // 7. Update metadata and changelog
  data.meta.updated = today;
  const addedCount = Math.max(0, data.news.length - beforeCount);
  if (processedNew.length > 0 || publishedArticle) {
    data.changelog.unshift({
      date: today,
      text: `Refreshed news feed (+${processedNew.length} new stories, ${data.news.length} total)${publishedArticle ? " and published a new cited article" : ""}.`
    });
    data.changelog = data.changelog.slice(0, 40);
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");

  console.log("=== Refresh Complete ===");
  console.log(`News before: ${beforeCount} -> News after: ${data.news.length} (+${processedNew.length} added)`);
  console.log(`Primary Hero Lead (#1): "${data.news[0]?.title || "none"}" (${data.news[0]?.source || ""})`);
  console.log(`Total Articles (posts): ${data.posts.length}`);
}

main().catch(err => {
  console.error("FATAL REFRESH ERROR:", err);
  process.exit(1);
});
