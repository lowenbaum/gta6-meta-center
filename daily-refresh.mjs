// scripts/daily-refresh.mjs
// Standalone Content Gathering & Meta Aggregation Engine for Meta Center
// Zero external npm dependencies required (uses native Node 20 fetch + fs).
import fs from "node:fs/promises";

const MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || GEMINI_API_KEY).trim();
const DATA_PATH = "./data.json";

const MAX_NEWS_ITEMS = 100;
const MIN_NEWS_RELEVANCE = 7;

// Source Authority Directory: guides Gemini's search & weights consensus rankings
const TRUSTED_SOURCES_DIRECTORY = [
  { name: "Broughy1322 (YouTube Track Lap Tests)", url: "https://www.youtube.com/@Broughy1322", kind: "youtube", weight: 1.25 },
  { name: "Digital Car Addict (YouTube Customization & Dyno)", url: "https://www.youtube.com/@DigitalCarAddict", kind: "youtube", weight: 1.2 },
  { name: "GhillieMaster (YouTube Weapon TTK & Combat Meta)", url: "https://www.youtube.com/@GhillieMaster", kind: "youtube", weight: 1.25 },
  { name: "TGG (YouTube Solo Money & Business Guides)", url: "https://www.youtube.com/@TGG", kind: "youtube", weight: 1.2 },
  { name: "Digital Foundry (Technical & Frame-Rate Analysis)", url: "https://www.youtube.com/@DigitalFoundry", kind: "youtube", weight: 1.25 },
  { name: "IGN GTA 6 Wiki & Interactive Map", url: "https://www.ign.com/wikis/gta-6", kind: "web", weight: 1.0 },
  { name: "Kotaku GTA 6 Coverage", url: "https://kotaku.com", kind: "web", weight: 1.0 },
  { name: "Eurogamer GTA 6 Guides", url: "https://www.eurogamer.net", kind: "web", weight: 1.0 },
  { name: "TechRadar GTA 6 Coverage", url: "https://www.techradar.com", kind: "web", weight: 1.0 },
  { name: "Inven Global GTA 6 Guides", url: "https://www.invenglobal.com", kind: "web", weight: 1.0 },
  { name: "PC Gamer GTA 6 Coverage", url: "https://www.pcgamer.com", kind: "web", weight: 1.0 },
  { name: "GameSpot GTA 6 Guides", url: "https://www.gamespot.com", kind: "web", weight: 1.0 }
];

const CATEGORY_CONFIG = {
  cars: {
    youtubeQuery: "GTA 6 best cars supercars lap time test tier list",
    searchFocus: "lap times, top speed mph tests, wet/dry handling, theft tool requirements (hotwire, slim jim, key cloner), and price/value"
  },
  weapons: {
    youtubeQuery: "GTA 6 best weapons guns TTK damage test tier list",
    searchFocus: "time-to-kill (TTK), recoil pattern, free-aim accuracy, suppressor synergy, and shared inventory mechanics between Jason and Lucia"
  },
  money: {
    youtubeQuery: "GTA 6 best money methods solo guide per hour",
    searchFocus: "solo cash per hour ($/hr), startup requirements, police heat risk, chop shop/fence payouts, and early vs. late game scaling"
  },
  gear: {
    youtubeQuery: "GTA 6 best gear upgrades tools key cloner slim jim",
    searchFocus: "unlock timing, return on investment, stealth/police delay benefits, vehicle theft access, and survivability"
  }
};

const NEWS_BEATS = [
  {
    name: "Patches, Performance & Official Rockstar Updates",
    cats: ["launch", "world"],
    targetCount: 6,
    youtubeQuery: "GTA 6 patch notes update performance PS5 Xbox Rockstar news",
    searchPrompt: (today) =>
      `Today is ${today}. Search Rockstar Newswire, PlayStation/Xbox updates, Digital Foundry, IGN, Eurogamer, TechRadar, VGC, and GameSpot for the most important recent Grand Theft Auto VI (GTA 6) official announcements, patch notes, balance changes, console performance findings, or major world updates. Focus strictly on verifiable facts—skip rumors or clickbait.`
  },
  {
    name: "Combat, Vehicles & Tested Gameplay Mechanics",
    cats: ["weapons", "vehicles", "tips"],
    targetCount: 6,
    youtubeQuery: "GTA 6 hidden mechanics tips combat weapons cars tested",
    searchPrompt: (today) =>
      `Today is ${today}. Search IGN, Kotaku, Inven Global, PC Gamer, GameSpot, and GTA 6 creator testing videos for high-value gameplay tips, combat mechanics, weapon/vehicle balance discoveries, controller settings optimizations, and police/stealth tricks that players can immediately use in GTA 6.`
  },
  {
    name: "Money Routes, Economy & Verified Secret Finds",
    cats: ["items", "eggs", "world"],
    targetCount: 6,
    youtubeQuery: "GTA 6 money guide easter eggs secrets map finds Leonida",
    searchPrompt: (today) =>
      `Today is ${today}. Search gaming press and community roundups (IGN, VGTimes, Dexerto, Kotaku, Inven Global, TechRadar) for confirmed GTA 6 money-making discoveries, heist/chop-shop economy tips, rare item locations, and verified Leonida easter eggs or secret encounters.`
  }
];

const GAMING_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" }
];

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "have", "into",
  "about", "after", "before", "gta", "grand", "theft", "auto", "how", "best", "new"
]);

const POSITIVE_COMMENT_TERMS = /\b(tested|works|working|legit|confirmed|accurate|best|helpful|goated|clutch|real|thanks)\b/i;
const NEGATIVE_COMMENT_TERMS = /\b(fake|clickbait|patched|cap|lie|lying|speculation|rumor|doesn't work|does not work|trash)\b/i;

function safeParseJson(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function titleTokens(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function isSimilarHeadline(candidateTitle, existingList) {
  const cand = titleTokens(candidateTitle);
  if (cand.size < 2) return false;
  for (const item of existingList) {
    const prev = titleTokens(item.title);
    if (prev.size < 2) continue;
    let overlap = 0;
    for (const word of cand) {
      if (prev.has(word)) overlap++;
    }
    const ratio = overlap / Math.min(cand.size, prev.size);
    if (ratio >= 0.6) return true;
  }
  return false;
}

async function callGeminiGroundedSearch(promptText) {
  for (const modelName of MODEL_CANDIDATES) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          tools: [{ googleSearch: {} }],
          safetySettings: GAMING_SAFETY_SETTINGS
        })
      });
      const json = await resp.json();
      if (!resp.ok || json.error) continue;
      const candidate = json.candidates?.[0];
      const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("\n");
      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      const urls = chunks
        .map((c) => (c.web ? `${c.web.title}: ${c.web.uri}` : null))
        .filter(Boolean)
        .join("\n");
      return `${text}\n\nVerified Grounding URLs:\n${urls}`;
    } catch {}
  }
  return "";
}

async function callGeminiJson(parts, responseSchema) {
  let lastErr = null;
  for (const modelName of MODEL_CANDIDATES) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          safetySettings: GAMING_SAFETY_SETTINGS,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema
          }
        })
      });
      const json = await resp.json();
      if (!resp.ok || json.error) {
        lastErr = new Error(`${modelName}: ${json.error?.message || resp.status}`);
        continue;
      }
      const candidate = json.candidates?.[0];
      if (!candidate?.content?.parts?.[0]?.text) {
        lastErr = new Error(`${modelName}: empty response`);
        continue;
      }
      const parsed = safeParseJson(candidate.content.parts[0].text);
      if (parsed) return parsed;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("All candidate models failed");
}

/* Fetches top viewer comments on a YouTube video to verify enthusiasm & reject clickbait */
async function evaluateVideoComments(videoId) {
  if (!YOUTUBE_API_KEY || !videoId) return { positiveHits: 0, negativeHits: 0, topQuotes: [] };
  try {
    const cUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=15&order=relevance&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const resp = await fetch(cUrl);
    if (!resp.ok) return { positiveHits: 0, negativeHits: 0, topQuotes: [] };
    const json = await resp.json();
    let positiveHits = 0;
    let negativeHits = 0;
    const topQuotes = [];
    for (const item of json.items || []) {
      const text = item.snippet?.topLevelComment?.snippet?.textOriginal || "";
      if (POSITIVE_COMMENT_TERMS.test(text)) positiveHits++;
      if (NEGATIVE_COMMENT_TERMS.test(text)) negativeHits++;
      if (topQuotes.length < 3 && text.length >= 15 && text.length <= 180) {
        topQuotes.push(text.replace(/\s+/g, " ").trim());
      }
    }
    return { positiveHits, negativeHits, topQuotes };
  } catch {
    return { positiveHits: 0, negativeHits: 0, topQuotes: [] };
  }
}

/* Discovers high-signal YouTube videos using Views + Like Ratio + Comment Sentiment */
async function discoverHighSignalVideos(categoryQuery, maxResults = 3, recentDays = null) {
  if (!YOUTUBE_API_KEY) return [];
  try {
    let publishedParam = "";
    if (recentDays) {
      const since = new Date(Date.now() - recentDays * 86400000).toISOString();
      publishedParam = `&publishedAfter=${encodeURIComponent(since)}`;
    }
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&order=relevance${publishedParam}&q=${encodeURIComponent(categoryQuery)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const sResp = await fetch(searchUrl);
    if (!sResp.ok) return [];
    const sJson = await sResp.json();
    const videoIds = (sJson.items || []).map((i) => i.id?.videoId).filter(Boolean);
    if (!videoIds.length) return [];

    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(videoIds.join(","))}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const vResp = await fetch(statsUrl);
    if (!vResp.ok) return [];
    const vJson = await vResp.json();

    const scoredVideos = [];
    for (const vid of vJson.items || []) {
      const views = Number(vid.statistics?.viewCount || 0);
      const likes = Number(vid.statistics?.likeCount || 0);
      const likeRatio = views > 0 ? (likes / views) * 100 : 0;
      const isAgeRestricted = vid.contentDetails?.contentRating?.ytRating === "ytAgeRestricted";

      if (views < 2500 || likeRatio < 2.0) continue;

      const commentSignals = await evaluateVideoComments(vid.id);
      // Disqualify videos where top comments call out clickbait or patched glitches
      if (commentSignals.negativeHits >= 3 && commentSignals.negativeHits > commentSignals.positiveHits) {
        continue;
      }

      const signalScore = Math.round(
        Math.log10(Math.max(10, views)) * 12 +
        likeRatio * 8 +
        commentSignals.positiveHits * 4 -
        commentSignals.negativeHits * 6
      );

      scoredVideos.push({
        url: `https://www.youtube.com/watch?v=${vid.id}`,
        title: vid.snippet?.title || "",
        description: (vid.snippet?.description || "").slice(0, 1600),
        channel: `${vid.snippet?.channelTitle || "Creator"} (YouTube)`,
        isAgeRestricted,
        views,
        likeRatio: `${likeRatio.toFixed(1)}%`,
        positiveComments: commentSignals.positiveHits,
        viewerConsensus: commentSignals.topQuotes,
        signalScore
      });
    }
    return scoredVideos.sort((a, b) => b.signalScore - a.signalScore).slice(0, maxResults);
  } catch {
    return [];
  }
}

/* 1. High-Volume 3-Beat News Aggregator */
async function refreshCommandCenterNews(existingNews, today) {
  const collected = [];
  const newsSchema = {
    type: "OBJECT",
    properties: {
      headlines: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            cat: { type: "STRING" },
            status: { type: "STRING" },
            tag: { type: "STRING" },
            source: { type: "STRING" },
            url: { type: "STRING" },
            title: { type: "STRING" },
            body: { type: "STRING" },
            relevanceScore: { type: "INTEGER" },
            isClickbaitOrSpeculation: { type: "BOOLEAN" }
          },
          required: ["id", "cat", "status", "source", "url", "title", "body", "relevanceScore", "isClickbaitOrSpeculation"]
        }
      }
    }
  };

  for (const beat of NEWS_BEATS) {
    try {
      console.log(`  [News Beat] Scanning: ${beat.name}...`);
      const knownTitles = [...existingNews, ...collected].slice(0, 50).map((n) => n.title);
      const beatVideos = await discoverHighSignalVideos(beat.youtubeQuery, 3, 14);
      const liveResearch = await callGeminiGroundedSearch(
        `${beat.searchPrompt(today)}\nDo NOT repeat any of these existing headlines: ${JSON.stringify(knownTitles)}.\nReturn ${beat.targetCount} distinct, high-value items with exact publisher names and verified URLs.`
      );

      const parsed = await callGeminiJson(
        [
          {
            text: `Context: Senior gaming editor for Meta Center (Grand Theft Auto VI).
Beat: ${beat.name} (preferred categories: ${beat.cats.join(", ")}).
Date: ${today}.
Extract up to ${beat.targetCount} distinct, factual, high-signal GTA 6 news items, patch details, or tested gameplay tips.
Strict Quality Rules:
1. Only include concrete, verifiable updates, tested mechanics, or confirmed finds.
2. Score relevanceScore from 1-10 (reserve 8-10 for major patches, high-impact tips, or confirmed discoveries).
3. Mark isClickbaitOrSpeculation = true for unverified rumors or filler listicles.
4. Use ONLY verified https:// URLs from the research or YouTube list below.
5. Do NOT duplicate any of these existing titles: ${JSON.stringify(knownTitles)}.

Live Web Research:
${liveResearch}

High-Engagement YouTube Videos (Verified by Viewer Comments):
${JSON.stringify(beatVideos)}`
          }
        ],
        newsSchema
      );

      for (const h of parsed?.headlines || []) {
        const validUrl = /^https:\/\//.test(h.url || "");
        const passesQuality =
          !h.isClickbaitOrSpeculation &&
          Number(h.relevanceScore || 0) >= MIN_NEWS_RELEVANCE &&
          validUrl &&
          h.title &&
          h.body;

        if (!passesQuality) continue;

        const allSoFar = [...existingNews, ...collected];
        const exactDup = allSoFar.some(
          (n) =>
            n.id === h.id ||
            n.title.toLowerCase() === h.title.toLowerCase()
        );

        if (!exactDup && !isSimilarHeadline(h.title, allSoFar)) {
          collected.push({
            id: h.id || `news-${Date.now()}-${collected.length}`,
            added: today,
            cat: ["launch", "tips", "eggs", "weapons", "vehicles", "items", "world"].includes(h.cat)
              ? h.cat
              : beat.cats[0],
            status: ["confirmed", "reported", "disputed"].includes(h.status) ? h.status : "reported",
            tag: h.tag || "Update",
            source: h.source,
            url: h.url,
            title: h.title.trim(),
            body: h.body.trim()
          });
        }
      }
    } catch (err) {
      console.warn(`  [News Beat] Warning in ${beat.name}:`, err.message);
    }
  }

  return collected;
}

/* 2. Category Meta Aggregator (Cars, Weapons, Money, Gear) */
async function refreshCategory(category, existingItems, today) {
  const cfg = CATEGORY_CONFIG[category];
  const discoveredVideos = await discoverHighSignalVideos(cfg.youtubeQuery, 3);
  const itemList = existingItems.map((i) => ({ id: i.id, name: i.name, type: i.type, get: i.get, facts: i.facts }));

  const liveWebResearch = await callGeminiGroundedSearch(
    `As of ${today}, search the web and YouTube for the latest Grand Theft Auto VI (GTA 6) rankings, tier lists, creator testing, and guide site consensus for category: "${category}" (${cfg.youtubeQuery}).
    Evaluation criteria: ${cfg.searchFocus}.
    Existing tracked items: ${JSON.stringify(itemList)}.
    Identify updated rankings for existing items AND any top-tier newly discovered ${category} items worth adding, along with real source names (IGN, Kotaku, Eurogamer, Inven Global, TechRadar, Broughy1322, Digital Car Addict, GhillieMaster, TGG) and verified URLs.`
  );

  // Inspect individual non-age-restricted YouTube videos natively (1 video per call)
  const videoInsights = [];
  for (const vid of discoveredVideos) {
    if (!vid.isAgeRestricted) {
      try {
        const vParsed = await callGeminiJson(
          [
            { fileData: { fileUri: vid.url, mimeType: "video/mp4" } },
            {
              text: `Context: Benign gaming frame analysis of Grand Theft Auto VI (${category}). Extract any ranked or tested items, exact MM:SS timestamp, rank position (1 to 10), and a 1-sentence testing quote.`
            }
          ],
          {
            type: "OBJECT",
            properties: {
              findings: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    itemName: { type: "STRING" },
                    rank: { type: "INTEGER" },
                    timestamp: { type: "STRING" },
                    quote: { type: "STRING" }
                  },
                  required: ["itemName", "rank", "quote"]
                }
              }
            }
          }
        );
        videoInsights.push({ video: vid, findings: vParsed?.findings || [] });
      } catch {
        videoInsights.push({ video: vid, findings: [] });
      }
    } else {
      videoInsights.push({ video: vid, findings: [] });
    }
  }

  const schema = {
    type: "OBJECT",
    properties: {
      patchNote: { type: "STRING" },
      items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            name: { type: "STRING" },
            type: { type: "STRING" },
            get: { type: "STRING" },
            blurb: { type: "STRING" },
            ranks: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  source: { type: "STRING" },
                  kind: { type: "STRING", description: "youtube or web" },
                  timestamp: { type: "STRING" },
                  quote: { type: "STRING" },
                  url: { type: "STRING" },
                  rank: { type: "INTEGER" }
                },
                required: ["source", "kind", "rank", "quote"]
              }
            }
          },
          required: ["id", "name", "ranks"]
        }
      }
    }
  };

  return await callGeminiJson(
    [
      {
        text: `Context: Benign software analysis of fictional video game item rankings for Meta Center (Grand Theft Auto VI).
Update the rankings for category "${category}".
Evaluation focus: ${cfg.searchFocus}.
Existing items: ${JSON.stringify(itemList)}
High-Engagement YouTube Videos & Viewer Consensus: ${JSON.stringify(videoInsights)}
Live Web Search Research: ${liveWebResearch}
Rules:
1. Every item MUST have at least 3 real named sources (combining YouTube testing channels and guide sites).
2. Never output "Sample site A/B/C".
3. Include an exact MM:SS timestamp and testing quote for YouTube sources.`
      }
    ],
    schema
  );
}

/* 3. Automated 3-Day Multi-Source Cited Article Generator */
async function maybeGenerateThreeDayArticle(data, today) {
  const posts = data.posts || [];
  const lastDate = posts[0]?.published || "2026-11-01";
  const daysSince = (new Date(today).getTime() - new Date(lastDate).getTime()) / 86400000;

  if (daysSince < 3 && process.env.FORCE_ARTICLE !== "true" && posts.length > 0) {
    console.log(`Skipping article generation (${daysSince.toFixed(1)} days since last post).`);
    return null;
  }

  console.log("Researching new 3-day multi-source cited article...");
  const existingSlugs = posts.map((p) => p.slug);
  const recentHeadlines = (data.news || []).slice(0, 12).map((n) => `${n.title} (${n.source}: ${n.url})`);

  const research = await callGeminiGroundedSearch(
    `As of ${today}, identify the biggest Grand Theft Auto VI (GTA 6) meta discovery, weapon/vehicle balance comparison, or solo money-making breakdown corroborated by at least 3 distinct gaming outlets or creators.
    Recent site headlines for context: ${JSON.stringify(recentHeadlines)}.
    Avoid existing article slugs: ${JSON.stringify(existingSlugs)}.`
  );

  const articleSchema = {
    type: "OBJECT",
    properties: {
      hasEnoughSources: { type: "BOOLEAN", description: "True ONLY if at least 3 solid sources exist" },
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
            p: { type: "ARRAY", items: { type: "STRING" } },
            list: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["h", "p"]
        }
      },
      sources: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            publisher: { type: "STRING" },
            url: { type: "STRING" },
            date: { type: "STRING" }
          },
          required: ["title", "publisher", "url"]
        }
      }
    },
    required: ["hasEnoughSources", "slug", "title", "dek", "sections", "sources"]
  };

  const article = await callGeminiJson(
    [
      {
        text: `Write an original, deeply researched GTA 6 analysis article for Meta Center based on this live research:
${research}

Strict Editorial Rules:
1. Require at least 3 distinct, real sources in the sources array (if fewer than 3 exist, set hasEnoughSources = false).
2. Cite sources inline in paragraphs using bracketed numbers like [1], [2], [3].
3. Write in a sharp, human editorial voice with concrete stats, payouts, or lap-time comparisons.`
      }
    ],
    articleSchema
  );

  if (article && article.hasEnoughSources && (article.sources || []).length >= 3) {
    return {
      slug: article.slug,
      title: article.title,
      dek: article.dek,
      author: "Meta Center Staff",
      published: today,
      updated: today,
      tags: article.tags?.length ? article.tags : ["Meta Analysis"],
      sections: article.sections,
      sources: article.sources
    };
  }
  return null;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await fs.readFile(DATA_PATH, "utf8");
  const data = safeParseJson(raw) || {
    meta: {},
    categories: { cars: [], weapons: [], money: [], gear: [] },
    news: [],
    posts: [],
    changelog: []
  };

  data.meta = data.meta || {};
  data.categories = data.categories || { cars: [], weapons: [], money: [], gear: [] };
  data.news = data.news || [];
  data.posts = data.posts || [];
  data.changelog = data.changelog || [];

  // Clean out any legacy sample flags or dummy seed votes
  for (const cat of Object.keys(data.categories)) {
    for (const item of data.categories[cat] || []) {
      item.sample = false;
      delete item.seedUp;
      delete item.seedVotes;
    }
  }

  if (GEMINI_API_KEY) {
    // 1. Run 3-Beat High-Volume News Engine
    try {
      console.log("Running 3-Beat High-Signal News Sweep...");
      const freshHeadlines = await refreshCommandCenterNews(data.news, today);
      for (const h of freshHeadlines.reverse()) {
        data.news.unshift(h);
      }
      data.news = data.news.slice(0, MAX_NEWS_ITEMS);
      console.log(`Added ${freshHeadlines.length} verified headlines (Archive size: ${data.news.length}).`);
    } catch (err) {
      console.warn("News sweep warning:", err.message);
    }

    // 2. Refresh Category Rankings & YouTube Creator Breakdowns
    for (const cat of Object.keys(data.categories)) {
      try {
        console.log(`Refreshing category: ${cat}...`);
        const res = await refreshCategory(cat, data.categories[cat], today);
        for (const upd of res?.items || []) {
          const target = data.categories[cat].find(
            (i) => i.id === upd.id || i.name.toLowerCase() === String(upd.name || "").toLowerCase()
          );
          if (target && upd.ranks?.length >= 2) {
            target.ranks = upd.ranks;
            if (upd.blurb) target.blurb = upd.blurb;
            target.sample = false;
          } else if (!target && upd.name && upd.ranks?.length >= 2) {
            data.categories[cat].push({
              id: upd.id || `${cat}-${upd.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
              name: upd.name,
              type: upd.type || "Meta Pick",
              get: upd.get || "In-game unlock",
              facts: {},
              blurb: upd.blurb || "",
              ranks: upd.ranks,
              sample: false,
              added: today
            });
          }
        }
      } catch (err) {
        console.warn(`Category ${cat} refresh warning:`, err.message);
      }
    }

    // 3. Check & Run 3-Day Cited Article Generator
    try {
      const newPost = await maybeGenerateThreeDayArticle(data, today);
      if (newPost && !data.posts.some((p) => p.slug === newPost.slug)) {
        data.posts.unshift(newPost);
        console.log(`Published new cited article: "${newPost.title}"`);
      }
    } catch (err) {
      console.warn("Article generator warning:", err.message);
    }
  }

  data.meta.updated = today;
  data.meta.newsSynced = today;
  data.meta.sourcesTracked = TRUSTED_SOURCES_DIRECTORY.map(({ name, url, kind }) => ({ name, url, kind }));

  data.changelog.unshift({
    date: today,
    text: `Synced ${data.news.length} Command Center headlines, verified YouTube comment signals, and refreshed category rankings.`
  });
  data.changelog = data.changelog.slice(0, 40);

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log("Saved updated data.json successfully.");
}

main().catch((err) => {
  console.warn("Handled error:", err.message);
  process.exit(0);
});
