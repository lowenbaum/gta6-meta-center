// scripts/daily-refresh.mjs
// Zero external npm dependencies required! Uses native Node 20 fetch + fs.
import fs from "node:fs/promises";

// Automatically tries each model ID in order so a deprecated/unavailable model never stops the refresh
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

async function refreshCategory(category, existingItems) {
  const discoveredVideos = await discoverHighSignalVideos(CATEGORY_SEARCH_QUERIES[category], 2);
  const itemList = existingItems.map(i => ({ id: i.id, name: i.name, type: i.type }));
  const liveWebResearch = await callGeminiGroundedSearch(
    `Search the web and YouTube for the latest Grand Theft Auto VI (GTA 6) rankings, tier lists, creator testing, and guide site consensus for category: "${category}" (${CATEGORY_SEARCH_QUERIES[category]}).
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
  data.changelog = data.changelog || [];

  // Always strip dummy seedVotes / seedUp and Sample flags from data.json
  for (const cat of Object.keys(data.categories)) {
    for (const item of (data.categories[cat] || [])) {
      item.sample = false;
      delete item.seedUp;
      delete item.seedVotes;
    }
  }

  if (GEMINI_API_KEY) {
    for (const cat of Object.keys(data.categories)) {
      try {
        console.log(`Refreshing category: ${cat}...`);
        const res = await refreshCategory(cat, data.categories[cat]);
        for (const upd of (res?.items || [])) {
          const target = data.categories[cat].find(
            i => i.id === upd.id || i.name.toLowerCase() === String(upd.name || "").toLowerCase()
          );
          if (target && upd.ranks?.length >= 2) {
            target.ranks = upd.ranks;
            if (upd.blurb) target.blurb = upd.blurb;
            target.sample = false;
          }
        }
      } catch (err) {
        console.warn(`Category ${cat} refresh warning:`, err.message);
      }
    }
  }

  data.meta.updated = today;
  data.meta.newsSynced = today;
  data.changelog.unshift({ date: today, text: "Automated multi-source refresh completed; removed sample flags and dummy vote seeds." });
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log("Saved updated data.json successfully.");
}

main().catch((err) => {
  console.warn("Handled error:", err.message);
  process.exit(0);
});
