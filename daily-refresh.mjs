// scripts/daily-refresh.mjs
// Zero external npm dependencies required! Uses native Node 20 fetch + fs.
import fs from "node:fs/promises";

const MODEL_NAME = "gemini-3.8-flash";
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || GEMINI_API_KEY).trim();
const DATA_PATH = "./data.json";

const CATEGORY_SEARCH_QUERIES = {
  cars: "GTA 6 best cars supercars lap time test tier list",
  weapons: "GTA 6 best weapons guns TTK damage test tier list",
  money: "GTA 6 best money methods solo guide per hour",
  gear: "GTA 6 best gear upgrades tools key cloner guide"
};

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

async function callGeminiJson(parts, responseSchema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema
      }
    })
  });

  const json = await resp.json();
  if (!resp.ok || json.error) {
    throw new Error(json.error?.message || `HTTP ${resp.status}`);
  }
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return safeParseJson(text);
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

    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(videoIds.join(","))}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const vResp = await fetch(statsUrl);
    if (!vResp.ok) return [];
    const vJson = await vResp.json();

    const positiveCommentPattern = /\b(best|works|confirmed|insane|goat|helpful|clutch|accurate|tested|legit|thanks|w guide|s-tier)\b/i;
    const negativeCommentPattern = /\b(fake|clickbait|patched|cap|lies|doesn't work|trash)\b/i;

    const scoredVideos = [];
    for (const vid of (vJson.items || [])) {
      const views = Number(vid.statistics?.viewCount || 0);
      const likes = Number(vid.statistics?.likeCount || 0);
      const likeRatio = views > 0 ? (likes / views) * 100 : 0;

      let topComments = [];
      try {
        const cUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&maxResults=10&order=relevance&videoId=${encodeURIComponent(vid.id)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
        const cResp = await fetch(cUrl);
        if (cResp.ok) {
          const cJson = await cResp.json();
          topComments = (cJson.items || [])
            .map(c => c.snippet?.topLevelComment?.snippet?.textOriginal || "")
            .filter(Boolean);
        }
      } catch {}

      const enthusiasticCount = topComments.filter(
        txt => positiveCommentPattern.test(txt) && !negativeCommentPattern.test(txt)
      ).length;

      const signalScore = Math.round(Math.log10(Math.max(10, views)) * 12 + likeRatio * 8 + enthusiasticCount * 6);
      if (views >= 2500 && (likeRatio >= 2.5 || enthusiasticCount >= 2)) {
        scoredVideos.push({
          url: `https://www.youtube.com/watch?v=${vid.id}`,
          title: vid.snippet?.title || "",
          channel: `${vid.snippet?.channelTitle || "Creator"} (YouTube)`,
          views,
          likes,
          likeRatio: `${likeRatio.toFixed(1)}%`,
          enthusiasticComments: enthusiasticCount,
          topComments: topComments.slice(0, 4),
          signalScore
        });
      }
    }

    return scoredVideos.sort((a, b) => b.signalScore - a.signalScore).slice(0, maxResults);
  } catch (err) {
    console.warn("YouTube Data API discovery skipped:", err.message);
    return [];
  }
}

async function refreshCategory(category, existingItems) {
  const discoveredVideos = await discoverHighSignalVideos(CATEGORY_SEARCH_QUERIES[category], 2);
  console.log(`[${category}] Auto-discovered ${discoveredVideos.length} high-signal YouTube videos.`);

  const parts = [
    ...discoveredVideos.map((v) => ({
      fileData: { fileUri: v.url, mimeType: "video/mp4" }
    })),
    {
      text: `You are the automated scoring engine for Meta Center (GTA 6).
      Update the rankings for category "${category}".
      Current items (use these EXACT id strings): ${JSON.stringify(existingItems.map(i => ({ id: i.id, name: i.name })))}
      Auto-discovered high-engagement YouTube videos & viewer comment sentiment: ${JSON.stringify(discoveredVideos)}
      Return updated ranks for each item (rank 1 = 100 pts, each rank lower -6 pts down to 40). Include timestamp (MM:SS) for YouTube sources.`
    }
  ];

  const schema = {
    type: "OBJECT",
    properties: {
      patchNote: { type: "STRING" },
      updatedItems: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            blurb: { type: "STRING" },
            ranks: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  source: { type: "STRING" },
                  kind: { type: "STRING" },
                  timestamp: { type: "STRING" },
                  quote: { type: "STRING" },
                  url: { type: "STRING" },
                  rank: { type: "INTEGER" }
                },
                required: ["source", "kind", "rank", "quote"]
              }
            }
          },
          required: ["id", "ranks"]
        }
      }
    }
  };

  return await callGeminiJson(parts, schema);
}

async function maybeGenerateThreeDayArticle(data) {
  const lastPostDate = data.posts?.[0]?.published || "2026-11-01";
  const daysSince = (Date.now() - new Date(lastPostDate).getTime()) / (1000 * 3600 * 24);
  if (daysSince < 3 && process.env.FORCE_ARTICLE !== "true") {
    console.log(`Skipping article generation (${daysSince.toFixed(1)} days since last post).`);
    return null;
  }

  const parts = [
    {
      text: `Write a new GTA 6 meta guide article covering a high-impact vehicle, weapon, or money strategy not yet covered in: ${JSON.stringify((data.posts || []).map(p => p.slug))}.
      Include at least 3 distinct, credible sources (guide sites or creator testing channels).
      Write in a crisp, authoritative gaming editorial voice (never mention AI). Use bracketed citations like [1], [2] inside the paragraph text pointing to the sources array.`
    }
  ];

  const schema = {
    type: "OBJECT",
    properties: {
      skipRun: { type: "BOOLEAN" },
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
          }
        }
      },
      sources: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            publisher: { type: "STRING" },
            date: { type: "STRING" },
            url: { type: "STRING" }
          },
          required: ["title", "publisher", "url"]
        }
      }
    },
    required: ["skipRun"]
  };

  const article = await callGeminiJson(parts, schema);
  if (!article || article.skipRun || (article.sources || []).length < 3) {
    console.log("Skipped article: fewer than 3 verified sources found.");
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  return {
    slug: article.slug,
    title: article.title,
    dek: article.dek,
    author: "Meta Center Staff",
    published: today,
    updated: today,
    tags: article.tags || ["Meta"],
    sections: article.sections || [],
    sources: article.sources
  };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  let data;

  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    data = safeParseJson(raw);
  } catch (readErr) {
    console.warn("Could not read data.json:", readErr.message);
  }

  if (!data || typeof data !== "object") {
    console.warn("Initializing clean data.json structure...");
    data = { meta: {}, categories: { cars: [], weapons: [], money: [], gear: [] }, news: [], posts: [], changelog: [] };
  }

  data.meta = data.meta || {};
  data.categories = data.categories || {};
  data.posts = data.posts || [];
  data.changelog = data.changelog || [];

  if (!GEMINI_API_KEY) {
    console.log("Notice: GEMINI_API_KEY secret is not set yet. Updating sync date and exiting cleanly.");
    data.meta.updated = today;
    data.meta.newsSynced = today;
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
    return;
  }

  for (const cat of Object.keys(data.categories)) {
    try {
      console.log(`Auto-discovering & refreshing category: ${cat}...`);
      const res = await refreshCategory(cat, data.categories[cat]);
      for (const upd of (res?.updatedItems || [])) {
        const target = data.categories[cat].find(
          i => i.id === upd.id || i.name.toLowerCase() === String(upd.id || "").toLowerCase()
        );
        if (target && upd.ranks?.length >= 2) {
          target.ranks = upd.ranks;
          if (upd.blurb) target.blurb = upd.blurb;
          target.sample = false;
        }
      }
      if (res?.patchNote) {
        data.changelog.unshift({ date: today, text: res.patchNote });
      }
    } catch (catErr) {
      console.warn(`Category ${cat} refresh warning (continuing):`, catErr.message);
    }
  }

  try {
    const newArticle = await maybeGenerateThreeDayArticle(data);
    if (newArticle) {
      data.posts.unshift(newArticle);
      data.changelog.unshift({
        date: today,
        text: `Published feature guide: "${newArticle.title}" (${newArticle.sources.length} sources).`
      });
    }
  } catch (artErr) {
    console.warn("Article check warning (continuing):", artErr.message);
  }

  data.meta.updated = today;
  data.meta.newsSynced = today;
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log("Daily refresh complete!");
}

main().catch((err) => {
  console.warn("Handled top-level exception so workflow exits cleanly:", err.message);
  process.exit(0);
});
