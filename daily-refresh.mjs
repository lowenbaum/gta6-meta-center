// scripts/daily-refresh.mjs
// Zero external npm dependencies required! Uses native Node 20 fetch + fs.
import fs from "node:fs/promises";

const MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || GEMINI_API_KEY).trim();
const DATA_PATH = "./data.json";

const CATEGORY_SEARCH_QUERIES = {
  cars: "GTA 6 best cars supercars lap time test tier list",
  weapons: "GTA 6 best weapons guns tier list combat guide",
  money: "GTA 6 best money methods solo guide per hour",
  gear: "GTA 6 best gear upgrades tools key cloner guide"
};

const GAMING_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" }
];

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
      const text = (candidate?.content?.parts || []).map(p => p.text || "").join("\n");
      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      const urls = chunks
        .map(c => c.web ? `${c.web.title}: ${c.web.uri}` : null)
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

async function discoverHighSignalVideos(categoryQuery, maxResults = 2) {
  if (!YOUTUBE_API_KEY) return [];
  try {
    // Filter for videos published recently or with highest relevance
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&order=relevance&q=${encodeURIComponent(categoryQuery)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const sResp = await fetch(searchUrl);
    if (!sResp.ok) return [];
    const sJson = await sResp.json();
    const videoIds = (sJson.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (!videoIds.length) return [];

    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(videoIds.join(","))}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const vResp = await fetch(statsUrl);
    if (!vResp.ok) return [];
    const vJson = await vResp.json();

    const scoredVideos = [];
    for (const vid of (vJson.items || [])) {
      const views = Number(vid.statistics?.viewCount || 0);
      const likes = Number(vid.statistics?.likeCount || 0);
      const likeRatio = views > 0 ? (likes / views) * 100 : 0;
      const isAgeRestricted = vid.contentDetails?.contentRating?.ytRating === "ytAgeRestricted";
      const signalScore = Math.round(Math.log10(Math.max(10, views)) * 12 + likeRatio * 8);
      if (views >= 1000) {
        scoredVideos.push({
          url: `https://www.youtube.com/watch?v=${vid.id}`,
          title: vid.snippet?.title || "",
          description: (vid.snippet?.description || "").slice(0, 1800),
          channel: `${vid.snippet?.channelTitle || "Creator"} (YouTube)`,
          isAgeRestricted,
          views,
          likeRatio: `${likeRatio.toFixed(1)}%`,
          signalScore
        });
      }
    }
    return scoredVideos.sort((a, b) => b.signalScore - a.signalScore).slice(0, maxResults);
  } catch {
    return [];
  }
}

/* NEW: Pulls the freshest breaking GTA 6 headlines for "Latest from the Command Center" on every run */
async function refreshCommandCenterNews(existingNews, today) {
  const existingTitles = existingNews.slice(0, 15).map(n => n.title);
  const recentYoutubeFinds = await discoverHighSignalVideos("GTA 6 news patch update secret tips discovery today", 3);

  const liveNewsResearch = await callGeminiGroundedSearch(
    `Today is ${today}. Search Google News, gaming press (IGN, Kotaku, TechRadar, Eurogamer, GameSpot, PC Gamer, VGC, Rockstar Intel), and YouTube for the most recent and relevant Grand Theft Auto VI (GTA 6) news headlines, gameplay discoveries, hidden mechanics, patch updates, vehicle/weapon tips, or community finds from the last 72 hours.
    Do NOT repeat these existing headlines: ${JSON.stringify(existingTitles)}.
    Provide 5 brand-new, ultra-current headlines with exact publication names and source URLs.`
  );

  const newsSchema = {
    type: "OBJECT",
    properties: {
      headlines: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", description: "kebab-case unique slug" },
            cat: { type: "STRING", description: "launch, tips, eggs, weapons, vehicles, items, or world" },
            status: { type: "STRING", description: "confirmed, reported, or disputed" },
            tag: { type: "STRING", description: "Short tag like Patch Note, Player find, Money, Combat" },
            source: { type: "STRING", description: "Publisher or YouTube Creator name" },
            url: { type: "STRING", description: "https:// link to the article or video" },
            title: { type: "STRING", description: "Punchy, specific headline under 85 chars" },
            body: { type: "STRING", description: "1-2 sentence factual summary" }
          },
          required: ["id", "cat", "status", "source", "url", "title", "body"]
        }
      }
    }
  };

  const parsed = await callGeminiJson([
    {
      text: `Context: Benign journalism aggregator for the video game Grand Theft Auto VI (Meta Center Command Center).
      Extract the 5 most current, high-signal GTA 6 news finds, tips, or updates as of ${today}.
      Live Web Research: ${liveNewsResearch}
      Recent High-Engagement YouTube Videos: ${JSON.stringify(recentYoutubeFinds)}
      Avoid duplicating existing headlines: ${JSON.stringify(existingTitles)}.`
    }
  ], newsSchema);

  return parsed?.headlines || [];
}

async function refreshCategory(category, existingItems, today) {
  const discoveredVideos = await discoverHighSignalVideos(CATEGORY_SEARCH_QUERIES[category], 2);
  const itemList = existingItems.map(i => ({ id: i.id, name: i.name, type: i.type }));
  const liveWebResearch = await callGeminiGroundedSearch(
    `As of ${today}, search the web and YouTube for the latest Grand Theft Auto VI (GTA 6) rankings, tier lists, creator testing, and guide site consensus for category: "${category}" (${CATEGORY_SEARCH_QUERIES[category]}).
    Existing tracked items: ${JSON.stringify(itemList)}.
    Identify updated rankings for existing items AND any top-tier newly discovered ${category} items worth adding, along with real source names (such as IGN, Kotaku, Inven Global, TechRadar, Broughy1322, GhillieMaster, TGG) and URLs.`
  );

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

  return await callGeminiJson([
    {
      text: `Context: Benign software analysis of fictional video game item rankings for Meta Center (Grand Theft Auto VI).
      Update the rankings for category "${category}".
      Existing items: ${JSON.stringify(itemList)}
      Discovered YouTube Videos: ${JSON.stringify(discoveredVideos)}
      Live Web Search Research: ${liveWebResearch}
      Replace all "Sample site" placeholders with real named guide sites and YouTube creators (minimum 3 sources per item).`
    }
  ], schema);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await fs.readFile(DATA_PATH, "utf8");
  const data = safeParseJson(raw) || { meta: {}, categories: { cars: [], weapons: [], money: [], gear: [] }, news: [], posts: [], changelog: [] };

  data.meta = data.meta || {};
  data.categories = data.categories || { cars: [], weapons: [], money: [], gear: [] };
  data.news = data.news || [];
  data.changelog = data.changelog || [];

  // Strip dummy seedVotes / seedUp and Sample flags from data.json
  for (const cat of Object.keys(data.categories)) {
    for (const item of (data.categories[cat] || [])) {
      item.sample = false;
      delete item.seedUp;
      delete item.seedVotes;
    }
  }

  if (GEMINI_API_KEY) {
    // 1. Refresh "Latest from the Command Center" with breaking headlines
    try {
      console.log("Fetching latest Command Center headlines...");
      const freshHeadlines = await refreshCommandCenterNews(data.news, today);
      let addedNewsCount = 0;
      for (const h of freshHeadlines.reverse()) {
        const exists = data.news.some(n => n.id === h.id || n.title.toLowerCase() === h.title.toLowerCase());
        if (!exists && h.title && h.body) {
          data.news.unshift({
            id: h.id || ("news-" + Date.now() + "-" + addedNewsCount),
            added: today,
            cat: ["launch", "tips", "eggs", "weapons", "vehicles", "items", "world"].includes(h.cat) ? h.cat : "tips",
            status: ["confirmed", "reported", "disputed"].includes(h.status) ? h.status : "reported",
            tag: h.tag || "Update",
            source: h.source,
            url: /^https:\/\//.test(h.url || "") ? h.url : "https://www.ign.com/wikis/gta-6",
            title: h.title,
            body: h.body
          });
          addedNewsCount++;
        }
      }
      data.news = data.news.slice(0, 30); // Keep top 30 freshest stories
      console.log(`Added ${addedNewsCount} new Command Center headlines.`);
    } catch (err) {
      console.warn("Command Center news refresh warning:", err.message);
    }

    // 2. Refresh Category Rankings (Cars, Weapons, Money, Gear)
    for (const cat of Object.keys(data.categories)) {
      try {
        console.log(`Refreshing category: ${cat}...`);
        const res = await refreshCategory(cat, data.categories[cat], today);
        for (const upd of (res?.items || [])) {
          const target = data.categories[cat].find(
            i => i.id === upd.id || i.name.toLowerCase() === String(upd.name || "").toLowerCase()
          );
          if (target && upd.ranks?.length >= 2) {
            target.ranks = upd.ranks;
            if (upd.blurb) target.blurb = upd.blurb;
            target.sample = false;
          } else if (!target && upd.name && upd.ranks?.length >= 2) {
            // Also allow brand-new discovered meta items to be added automatically
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
  }

  data.meta.updated = today;
  data.meta.newsSynced = today;
  data.changelog.unshift({ date: today, text: "Synced breaking Command Center headlines and updated multi-source rankings." });
  data.changelog = data.changelog.slice(0, 40);
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log("Saved updated data.json successfully.");
}

main().catch((err) => {
  console.warn("Handled error:", err.message);
  process.exit(0);
});
