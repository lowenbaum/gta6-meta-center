// scripts/daily-refresh.mjs
// High-Volume Content Gathering, Hero Story Curation, Multi-Desk Article & Meta Aggregation Engine
// Zero external npm dependencies required (uses native Node 20 fetch + fs).
import fs from "node:fs/promises";

const MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || GEMINI_API_KEY).trim();
const DATA_PATH = "./data.json";

// High-volume configuration with strict quality floors
const MAX_NEWS_ITEMS = 250;
const MIN_NEWS_RELEVANCE = 7;
const MAX_POSTS_ARCHIVE = 60;
const ARTICLES_PER_RUN = Number(process.env.ARTICLES_PER_RUN || (process.env.FORCE_ARTICLE === "true" ? 3 : 2));

// Boilerplate/utility story IDs or patterns that must NEVER occupy the #1 Primary/Hero slot
const BOILERPLATE_UTILITY_IDS = new Set(["ps5-system-update", "saving", "settings-deadzone"]);
const BOILERPLATE_TITLE_REGEX = /\b(firmware|system update|install update|rest mode|dead\s*zone|patch size|preload)\b/i;

// Expanded Source Authority Directory (18 specialist creators, outlets & wikis)
const TRUSTED_SOURCES_DIRECTORY = [
  { name: "Broughy1322 (YouTube Track Lap Tests)", url: "https://www.youtube.com/@Broughy1322", kind: "youtube", weight: 1.25 },
  { name: "Digital Car Addict (YouTube Customization & Dyno)", url: "https://www.youtube.com/@DigitalCarAddict", kind: "youtube", weight: 1.2 },
  { name: "GhillieMaster (YouTube Weapon TTK & Combat Meta)", url: "https://www.youtube.com/@GhillieMaster", kind: "youtube", weight: 1.25 },
  { name: "TGG (YouTube Solo Money & Business Guides)", url: "https://www.youtube.com/@TGG", kind: "youtube", weight: 1.2 },
  { name: "Digital Foundry (Technical & Frame-Rate Analysis)", url: "https://www.youtube.com/@DigitalFoundry", kind: "youtube", weight: 1.25 },
  { name: "TheProfessional (YouTube Heist & Money Grinding)", url: "https://www.youtube.com/@TheProfessional1994", kind: "youtube", weight: 1.2 },
  { name: "HarmNone (YouTube Vehicle & Gear Reviews)", url: "https://www.youtube.com/@HarmNone", kind: "youtube", weight: 1.15 },
  { name: "Pyrerealm Gaming (YouTube Mythbusting & Comparisons)", url: "https://www.youtube.com/@PyrerealmGaming", kind: "youtube", weight: 1.15 },
  { name: "DarkViperAU (YouTube Speedrun & Mechanics Science)", url: "https://www.youtube.com/@DarkViperAU", kind: "youtube", weight: 1.15 },
  { name: "IGN GTA 6 Wiki & Interactive Map", url: "https://www.ign.com/wikis/gta-6", kind: "web", weight: 1.0 },
  { name: "Kotaku GTA 6 Coverage", url: "https://kotaku.com", kind: "web", weight: 1.0 },
  { name: "Eurogamer GTA 6 Guides", url: "https://www.eurogamer.net", kind: "web", weight: 1.0 },
  { name: "TechRadar GTA 6 Coverage", url: "https://www.techradar.com", kind: "web", weight: 1.0 },
  { name: "Inven Global GTA 6 Guides", url: "https://www.invenglobal.com", kind: "web", weight: 1.0 },
  { name: "PC Gamer GTA 6 Coverage", url: "https://www.pcgamer.com", kind: "web", weight: 1.0 },
  { name: "GameSpot GTA 6 Guides", url: "https://www.gamespot.com", kind: "web", weight: 1.0 },
  { name: "GamesRadar+ GTA 6 Guides", url: "https://www.gamesradar.com", kind: "web", weight: 1.0 },
  { name: "Video Games Chronicle (VGC)", url: "https://www.videogameschronicle.com", kind: "web", weight: 1.0 }
];

// Multi-query category configuration + target catalog growth
const CATEGORY_CONFIG = {
  cars: {
    targetCatalogSize: 15,
    factKeys: ["Top speed", "Handling", "Theft"],
    youtubeQueries: [
      "GTA 6 best cars supercars lap time test tier list",
      "GTA 6 fastest sports cars armored getaway vehicles tested"
    ],
    searchFocus: "lap times, top speed mph tests, wet/dry handling, armor durability, theft tool requirements (hotwire, slim jim, key cloner), and price/value across Super, Sports, Muscle, SUV, and Motorcycle classes"
  },
  weapons: {
    targetCatalogSize: 14,
    factKeys: ["Damage", "Range", "Recoil"],
    youtubeQueries: [
      "GTA 6 best weapons guns TTK damage test tier list",
      "GTA 6 best rifles shotguns pistols drive-by SMG comparison"
    ],
    searchFocus: "time-to-kill (TTK), headshot multiplier, recoil pattern, free-aim accuracy, drive-by fire rate, suppressor synergy, and shared inventory mechanics between Jason and Lucia"
  },
  money: {
    targetCatalogSize: 12,
    factKeys: ["Payout", "Time", "Risk"],
    youtubeQueries: [
      "GTA 6 best money methods solo guide per hour",
      "GTA 6 heist payouts chop shop fencing passive income guide"
    ],
    searchFocus: "solo cash per hour ($/hr), cooldown timers, startup requirements, police heat risk, chop shop/fence payouts, ATM laundering, and early vs. late game scaling"
  },
  gear: {
    targetCatalogSize: 12,
    factKeys: ["Effect", "Cost", "Unlocks"],
    youtubeQueries: [
      "GTA 6 best gear upgrades tools key cloner slim jim",
      "GTA 6 best weapon attachments armor stealth heist equipment"
    ],
    searchFocus: "unlock timing, return on investment, stealth/police delay benefits, vehicle theft access, carry capacity upgrades, and combat survivability"
  }
};

// 6 Specialized News Beats — Ordered so Major Meta, Gameplay & Headline Stories lead first
const NEWS_BEATS = [
  {
    name: "Major Meta Shifts, Breaking Rockstar Headlines & World Events",
    cats: ["world", "launch"],
    targetCount: 8,
    youtubeQuery: "GTA 6 biggest news meta update Rockstar announcement",
    searchPrompt: (today) =>
      `Today is ${today}. Search Rockstar Newswire, IGN, Kotaku, Eurogamer, VGC, GameSpot, and PC Gamer for the biggest, most timely Grand Theft Auto VI (GTA 6) headlines, major gameplay revelations, meta shifts, high-impact balance updates, and official Rockstar announcements. Avoid mundane firmware/install notices.`
  },
  {
    name: "Vehicle Meta, Lap Times & Customization Discoveries",
    cats: ["vehicles", "tips"],
    targetCount: 8,
    youtubeQuery: "GTA 6 fastest car test Broughy1322 Digital Car Addict Pay n Spray",
    searchPrompt: (today) =>
      `Today is ${today}. Search GTA 6 vehicle testing channels (Broughy1322, Digital Car Addict, HarmNone) and gaming guides for new fastest car lap-time tests, secret vehicle spawn locations, Pay 'n' Spray registration tricks, key cloner/slim jim theft mechanics, and hidden customization upgrades.`
  },
  {
    name: "Weapon Loadouts, Combat Science & Police Evasion",
    cats: ["weapons", "tips"],
    targetCount: 8,
    youtubeQuery: "GTA 6 weapon damage test GhillieMaster combat tips police wanted level",
    searchPrompt: (today) =>
      `Today is ${today}. Search GhillieMaster, IGN, Kotaku, Inven Global, and GamesRadar for GTA 6 weapon damage breakdowns, attachment synergies (suppressors, extended mags, scopes), free-aim disarming mechanics, Jason/Lucia shared inventory rules, and police dispatch evasion tactics.`
  },
  {
    name: "Solo Money Routes, Chop Shops & Heist Economy",
    cats: ["items", "tips"],
    targetCount: 8,
    youtubeQuery: "GTA 6 solo money guide TGG chop shop fence heist payout",
    searchPrompt: (today) =>
      `Today is ${today}. Search TGG, TheProfessional, Inven Global, GameSpot, and PC Gamer for verified GTA 6 money-making methods, store robbery stealth loops, chop-shop tracker removal payouts, fence reputation unlocks, ATM cash cap management, and heist setup optimizations.`
  },
  {
    name: "Leonida Easter Eggs, Random Events & World Secrets",
    cats: ["eggs", "world"],
    targetCount: 8,
    youtubeQuery: "GTA 6 easter eggs secrets Vice City Lake Cottonmouth mysteries found",
    searchPrompt: (today) =>
      `Today is ${today}. Search VGTimes, Kotaku, GamesRadar, IGN, and community discovery channels for confirmed GTA 6 easter eggs, Lake Cottonmouth mysteries, rare random encounters, safehouse secrets, and hidden collectibles across Leonida.`
  },
  {
    name: "Console Performance, Frame-Rate & Tactical Settings",
    cats: ["tips", "launch"],
    targetCount: 8,
    youtubeQuery: "GTA 6 Digital Foundry PS5 Pro Xbox Series X performance settings",
    searchPrompt: (today) =>
      `Today is ${today}. Search Digital Foundry, TechRadar, Eurogamer, and creator benchmarks for GTA 6 frame-rate tests, graphics modes, aiming settings, and gameplay optimization tips.`
  }
];

// 5 Rotating Editorial Desks for Multi-Source Cited Articles
const EDITORIAL_DESKS = [
  {
    id: "vehicle-lap-meta",
    tag: "Vehicle Analysis",
    topicPrompt: "Deep-dive comparison of the fastest GTA 6 supercars, sports cars, and getaway vehicles—analyzing track lap times, wet-road handling penalties, and key cloner acquisition costs."
  },
  {
    id: "weapon-ttk-loadouts",
    tag: "Combat & Loadouts",
    topicPrompt: "Comprehensive GTA 6 weapon meta and TTK guide—comparing Rifles, Shotguns, Revolvers, and Drive-by SMGs, plus suppressor police-delay mechanics and Jason/Lucia inventory split."
  },
  {
    id: "solo-money-economy",
    tag: "Money & Economy",
    topicPrompt: "The definitive GTA 6 solo money-making breakdown—comparing early-game clean store robberies, mid-game chop-shop car flipping (with tracker removal), and late-game heist payouts per hour."
  },
  {
    id: "stealth-police-gear",
    tag: "Gear & Mechanics",
    topicPrompt: "How GTA 6's 3-tier car theft system (Hotwire, Slim Jim, Key Cloner), witness/police dispatch timers, and essential gear upgrades change how you plan every robbery and getaway."
  },
  {
    id: "performance-settings-patch",
    tag: "Technical & Settings",
    topicPrompt: "Essential GTA 6 settings, controller dead-zone tuning, manual save strategies, and console performance optimizations tested by reviewers and technical analysts."
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
    if (ratio >= 0.65) return true;
  }
  return false;
}

/* Calculates how worthy a news story is for the #1 Primary/Hero slot */
function computeHeroScore(story, today) {
  if (!story || !story.title) return -100;
  let score = Number(story.heroPriorityScore || story.relevanceScore || 7) * 10;

  if (story.isTimelyHeroLead) score += 35;
  if (story.added === today) score += 25;
  if (story.status === "confirmed") score += 12;
  if (["vehicles", "weapons", "items", "world"].includes(story.cat)) score += 10;

  // Strongly demote dry utility/install/firmware notices so they never become the Hero story
  if (BOILERPLATE_UTILITY_IDS.has(story.id) || BOILERPLATE_TITLE_REGEX.test(story.title)) {
    score -= 150;
  }
  return score;
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

/* Evaluates top viewer comments on a YouTube video to confirm quality & reject clickbait */
async function evaluateVideoComments(videoId) {
  if (!YOUTUBE_API_KEY || !videoId) return { positiveHits: 0, negativeHits: 0, topQuotes: [] };
  try {
    const cUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=20&order=relevance&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
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
      if (topQuotes.length < 4 && text.length >= 15 && text.length <= 180) {
        topQuotes.push(text.replace(/\s+/g, " ").trim());
      }
    }
    return { positiveHits, negativeHits, topQuotes };
  } catch {
    return { positiveHits: 0, negativeHits: 0, topQuotes: [] };
  }
}

/* Discovers high-signal YouTube videos across one or more queries */
async function discoverHighSignalVideos(queriesInput, maxResults = 5, recentDays = null) {
  if (!YOUTUBE_API_KEY) return [];
  const queries = Array.isArray(queriesInput) ? queriesInput : [queriesInput];
  const allVideoIds = new Set();

  try {
    let publishedParam = "";
    if (recentDays) {
      const since = new Date(Date.now() - recentDays * 86400000).toISOString();
      publishedParam = `&publishedAfter=${encodeURIComponent(since)}`;
    }

    for (const q of queries) {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&order=relevance${publishedParam}&q=${encodeURIComponent(q)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
      const sResp = await fetch(searchUrl);
      if (!sResp.ok) continue;
      const sJson = await sResp.json();
      for (const item of sJson.items || []) {
        if (item.id?.videoId) allVideoIds.add(item.id.videoId);
      }
    }

    const idList = [...allVideoIds].slice(0, 25);
    if (!idList.length) return [];

    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(idList.join(","))}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const vResp = await fetch(statsUrl);
    if (!vResp.ok) return [];
    const vJson = await vResp.json();

    const scoredVideos = [];
    for (const vid of vJson.items || []) {
      const views = Number(vid.statistics?.viewCount || 0);
      const likes = Number(vid.statistics?.likeCount || 0);
      const likeRatio = views > 0 ? (likes / views) * 100 : 0;
      const isAgeRestricted = vid.contentDetails?.contentRating?.ytRating === "ytAgeRestricted";

      if (views < 1000 || likeRatio < 1.8) continue;

      const commentSignals = await evaluateVideoComments(vid.id);
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

/* 1. High-Volume 6-Beat News Aggregator + Hero Lead Ranking (Up to 48 stories per run) */
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
            relevanceScore: { type: "INTEGER", description: "1 to 10 quality score" },
            heroPriorityScore: { type: "INTEGER", description: "1 to 100 editorial headline impact score" },
            isTimelyHeroLead: { type: "BOOLEAN", description: "True if this is a major front-page lead story" },
            isClickbaitOrSpeculation: { type: "BOOLEAN" }
          },
          required: [
            "id", "cat", "status", "source", "url", "title", "body",
            "relevanceScore", "heroPriorityScore", "isTimelyHeroLead", "isClickbaitOrSpeculation"
          ]
        }
      }
    }
  };

  for (const beat of NEWS_BEATS) {
    try {
      console.log(`  [News Beat] Scanning: ${beat.name}...`);
      const knownTitles = [...existingNews, ...collected].slice(0, 80).map((n) => n.title);
      const beatVideos = await discoverHighSignalVideos(beat.youtubeQuery, 4, 21);
      const liveResearch = await callGeminiGroundedSearch(
        `${beat.searchPrompt(today)}\nDo NOT repeat any of these existing headlines: ${JSON.stringify(knownTitles)}.\nReturn ${beat.targetCount} distinct, high-value items with exact publisher names and verified URLs.`
      );

      const parsed = await callGeminiJson(
        [
          {
            text: `Context: Editor-in-Chief for Meta Center (Grand Theft Auto VI).
Beat: ${beat.name} (preferred categories: ${beat.cats.join(", ")}).
Date: ${today}.
Extract up to ${beat.targetCount} distinct, factual, high-signal GTA 6 news items, meta breakthroughs, or tested gameplay findings.
Strict Quality & Hero Curation Rules:
1. Only include concrete, verifiable updates, tested meta findings, or confirmed news.
2. Score relevanceScore from 1-10 (require >= 7 for inclusion).
3. Score heroPriorityScore from 1-100 based on how exciting, timely, and important the story is for the #1 Front-Page Hero Headline. Major meta shifts, new fastest car/weapon tests, huge money discoveries, or big Rockstar announcements should score 85-100. Routine firmware/system update notices must score below 25 and have isTimelyHeroLead = false.
4. Mark isClickbaitOrSpeculation = true for unverified rumors or filler listicles.
5. Use ONLY verified https:// URLs from the research or YouTube list below.
6. Do NOT duplicate any of these existing titles: ${JSON.stringify(knownTitles)}.

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
            body: h.body.trim(),
            relevanceScore: Number(h.relevanceScore || 8),
            heroPriorityScore: Number(h.heroPriorityScore || 75),
            isTimelyHeroLead: Boolean(h.isTimelyHeroLead)
          });
        }
      }
    } catch (err) {
      console.warn(`  [News Beat] Warning in ${beat.name}:`, err.message);
    }
  }

  return collected;
}

/* 2. Category Meta Aggregator + Automatic Catalog Expansion */
async function refreshCategory(category, existingItems, today) {
  const cfg = CATEGORY_CONFIG[category];
  const discoveredVideos = await discoverHighSignalVideos(cfg.youtubeQueries, 5);
  const itemList = existingItems.map((i) => ({ id: i.id, name: i.name, type: i.type, get: i.get, facts: i.facts }));
  const expansionNeeded = Math.max(2, cfg.targetCatalogSize - existingItems.length);

  const liveWebResearch = await callGeminiGroundedSearch(
    `As of ${today}, search the web and YouTube for the latest Grand Theft Auto VI (GTA 6) rankings, tier lists, creator testing, and guide site consensus for category: "${category}".
    Evaluation criteria: ${cfg.searchFocus}.
    Existing tracked items (${existingItems.length}): ${JSON.stringify(itemList)}.
    IMPORTANT QUANTITY & DEPTH GOAL: In addition to updating the existing ${existingItems.length} items, identify at least ${Math.min(4, expansionNeeded)} additional high-interest GTA 6 ${category} items tested by guide sites and YouTube creators that are not yet in the list above, along with real source names (IGN, Kotaku, Eurogamer, Inven Global, TechRadar, GamesRadar, Broughy1322, Digital Car Addict, GhillieMaster, TGG) and verified URLs.`
  );

  const videoInsights = [];
  for (const vid of discoveredVideos.slice(0, 3)) {
    if (!vid.isAgeRestricted) {
      try {
        const vParsed = await callGeminiJson(
          [
            { fileData: { fileUri: vid.url, mimeType: "video/mp4" } },
            {
              text: `Context: Benign gaming frame analysis of Grand Theft Auto VI (${category}). Extract every ranked or tested item, exact MM:SS timestamp, rank position (1 to 15), and a 1-sentence testing quote.`
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
            facts: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  label: { type: "STRING" },
                  value: { type: "STRING" }
                },
                required: ["label", "value"]
              }
            },
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
          required: ["id", "name", "type", "get", "blurb", "ranks"]
        }
      }
    }
  };

  return await callGeminiJson(
    [
      {
        text: `Context: Benign software analysis of fictional video game item rankings for Meta Center (Grand Theft Auto VI).
Update the rankings for category "${category}" AND expand the catalog with at least ${Math.min(4, expansionNeeded)} newly discovered items from the research below.
Evaluation focus: ${cfg.searchFocus}.
Preferred fact labels for each item: ${JSON.stringify(cfg.factKeys)}.
Existing items: ${JSON.stringify(itemList)}
High-Engagement YouTube Videos & Viewer Consensus: ${JSON.stringify(videoInsights)}
Live Web Search Research: ${liveWebResearch}
Rules:
1. Return all existing items with updated multi-source rankings PLUS 2 to 4 new well-sourced items for "${category}".
2. Every item MUST have between 3 and 6 real named sources (combining YouTube testing channels and guide sites).
3. Never output "Sample site A/B/C".
4. Include an exact MM:SS timestamp and testing quote for YouTube sources.`
      }
    ],
    schema
  );
}

/* 3. Multi-Desk Cited Article Engine (Generates up to ARTICLES_PER_RUN deep-dive articles per run) */
async function generateBatchCitedArticles(data, today) {
  const existingPosts = data.posts || [];
  const existingSlugs = new Set(existingPosts.map((p) => p.slug));
  const existingTitles = existingPosts.map((p) => p.title);
  const recentHeadlines = (data.news || []).slice(0, 25).map((n) => `${n.title} (${n.source}: ${n.url})`);

  const deskCounts = EDITORIAL_DESKS.map((desk) => ({
    desk,
    count: existingPosts.filter((p) => (p.tags || []).includes(desk.tag)).length
  })).sort((a, b) => a.count - b.count);

  const selectedDesks = deskCounts.slice(0, Math.max(1, ARTICLES_PER_RUN)).map((d) => d.desk);
  const generatedPosts = [];

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

  for (const desk of selectedDesks) {
    try {
      console.log(`  [Article Desk] Researching "${desk.tag}" feature...`);
      const research = await callGeminiGroundedSearch(
        `As of ${today}, research a fresh, specific, high-value Grand Theft Auto VI (GTA 6) analysis feature for our "${desk.tag}" desk.
        Focus: ${desk.topicPrompt}
        Recent site headlines for context: ${JSON.stringify(recentHeadlines)}.
        Do NOT repeat any of these existing article titles: ${JSON.stringify([...existingTitles, ...generatedPosts.map((p) => p.title)])}.
        Find at least 4 distinct gaming outlets, wikis, or specialist YouTube testing channels with verified URLs.`
      );

      const article = await callGeminiJson(
        [
          {
            text: `Write an original, deeply researched 4-section GTA 6 analysis article for Meta Center's "${desk.tag}" desk based on this live research:
${research}

Strict Editorial & Quality Rules:
1. Require at least 3 to 5 distinct, real sources in the sources array with verified https:// URLs (if fewer than 3 exist, set hasEnoughSources = false).
2. Cite sources inline in paragraphs using bracketed numbers like [1], [2], [3], [4].
3. Include 3 to 4 substantive sections (each with a clear subheading "h", 2 detailed paragraphs in "p", and an optional bulleted takeaway "list").
4. Write in a sharp, authoritative human editorial voice with concrete stats, payouts, or test figures.
5. Do not duplicate any existing titles: ${JSON.stringify(existingTitles)}.`
          }
        ],
        articleSchema
      );

      const validSources = (article?.sources || []).filter((s) => /^https:\/\//.test(s.url || ""));
      if (
        article &&
        article.hasEnoughSources &&
        validSources.length >= 3 &&
        article.slug &&
        !existingSlugs.has(article.slug) &&
        !isSimilarHeadline(article.title, [...existingPosts, ...generatedPosts])
      ) {
        existingSlugs.add(article.slug);
        generatedPosts.push({
          slug: article.slug,
          title: article.title.trim(),
          dek: article.dek.trim(),
          author: "Meta Center Staff",
          published: today,
          updated: today,
          tags: [desk.tag, ...(article.tags || []).filter((t) => t !== desk.tag)].slice(0, 3),
          sections: article.sections,
          sources: validSources
        });
        console.log(`  [Article Desk] Published: "${article.title}" (${validSources.length} sources)`);
      }
    } catch (err) {
      console.warn(`  [Article Desk] Warning on ${desk.id}:`, err.message);
    }
  }

  return generatedPosts;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

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

  // CRITICAL FIX: Normalize any hardcoded future "2026-11-..." dates on legacy starter items
  // so they never out-sort fresh daily stories, and demote the old PS5 firmware update notice.
  for (const n of data.news) {
    if (!n.added || n.added > today) {
      n.added = yesterday;
    }
    if (BOILERPLATE_UTILITY_IDS.has(n.id) || BOILERPLATE_TITLE_REGEX.test(n.title || "")) {
      n.added = "2025-01-01";
      n.heroPriorityScore = 10;
      n.isTimelyHeroLead = false;
    }
  }

  // Clean out any legacy sample flags or dummy seed votes
  for (const cat of Object.keys(data.categories)) {
    for (const item of data.categories[cat] || []) {
      item.sample = false;
      delete item.seedUp;
      delete item.seedVotes;
    }
  }

  let addedNewsCount = 0;
  let addedItemsCount = 0;
  let addedArticlesCount = 0;

  if (GEMINI_API_KEY) {
    // 1. Run 6-Beat High-Volume News Engine (Up to 48 fresh stories per run)
    try {
      console.log("Running 6-Beat High-Signal News Sweep...");
      const freshHeadlines = await refreshCommandCenterNews(data.news, today);
      addedNewsCount = freshHeadlines.length;

      // Combine fresh headlines with existing archive
      const combinedNews = [...freshHeadlines, ...data.news];

      // Sort by Hero Priority Score first among today's stories, then by date descending
      combinedNews.sort((a, b) => {
        if (a.added !== b.added) {
          return (b.added || "").localeCompare(a.added || "");
        }
        return computeHeroScore(b, today) - computeHeroScore(a, today);
      });

      // Guarantee the #1 Primary/Hero slot is the highest-scoring timely story (never a firmware/install notice)
      const bestHeroIdx = combinedNews.findIndex(
        (n) => !BOILERPLATE_UTILITY_IDS.has(n.id) && !BOILERPLATE_TITLE_REGEX.test(n.title || "")
      );
      if (bestHeroIdx > 0) {
        const [heroStory] = combinedNews.splice(bestHeroIdx, 1);
        heroStory.added = today;
        combinedNews.unshift(heroStory);
      }

      data.news = combinedNews.slice(0, MAX_NEWS_ITEMS);
      console.log(
        `Added ${addedNewsCount} verified headlines (Total: ${data.news.length}). Hero Lead: "${data.news[0]?.title}"`
      );
    } catch (err) {
      console.warn("News sweep warning:", err.message);
    }

    // 2. Refresh Category Rankings & Expand Catalogs
    for (const cat of Object.keys(data.categories)) {
      try {
        console.log(`Refreshing & expanding category: ${cat}...`);
        const res = await refreshCategory(cat, data.categories[cat], today);
        for (const upd of res?.items || []) {
          const target = data.categories[cat].find(
            (i) => i.id === upd.id || i.name.toLowerCase() === String(upd.name || "").toLowerCase()
          );
          const factsObj = {};
          for (const f of upd.facts || []) {
            if (f.label && f.value) factsObj[f.label] = f.value;
          }

          if (target && upd.ranks?.length >= 2) {
            target.ranks = upd.ranks;
            if (upd.blurb) target.blurb = upd.blurb;
            if (upd.type) target.type = upd.type;
            if (upd.get) target.get = upd.get;
            if (Object.keys(factsObj).length > 0) {
              target.facts = { ...(target.facts || {}), ...factsObj };
            }
            target.sample = false;
          } else if (!target && upd.name && upd.ranks?.length >= 2) {
            data.categories[cat].push({
              id: upd.id || `${cat}-${upd.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
              name: upd.name,
              type: upd.type || "Meta Pick",
              get: upd.get || "In-game unlock",
              facts: Object.keys(factsObj).length > 0 ? factsObj : { Status: "Reviewer tested" },
              blurb: upd.blurb || "",
              ranks: upd.ranks,
              sample: false,
              added: today
            });
            addedItemsCount++;
          }
        }
      } catch (err) {
        console.warn(`Category ${cat} refresh warning:`, err.message);
      }
    }

    // 3. Run Multi-Desk Cited Article Engine (2+ new articles per run)
    try {
      console.log(`Running Multi-Desk Article Engine (target: ${ARTICLES_PER_RUN} new articles)...`);
      const newPosts = await generateBatchCitedArticles(data, today);
      addedArticlesCount = newPosts.length;
      for (const post of newPosts.reverse()) {
        data.posts.unshift(post);
      }
      data.posts = data.posts.slice(0, MAX_POSTS_ARCHIVE);
      console.log(`Added ${addedArticlesCount} new multi-source articles (Total posts: ${data.posts.length}).`);
    } catch (err) {
      console.warn("Article generator warning:", err.message);
    }
  }

  data.meta.updated = today;
  data.meta.newsSynced = today;
  data.meta.sourcesTracked = TRUSTED_SOURCES_DIRECTORY.map(({ name, url, kind }) => ({ name, url, kind }));

  data.changelog.unshift({
    date: today,
    text: `Expanded coverage: +${addedNewsCount} verified headlines (${data.news.length} total), +${addedArticlesCount} cited articles (${data.posts.length} total), and +${addedItemsCount} newly ranked items.`
  });
  data.changelog = data.changelog.slice(0, 50);

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log("Saved updated data.json successfully.");
}

main().catch((err) => {
  console.warn("Handled error:", err.message);
  process.exit(0);
});
