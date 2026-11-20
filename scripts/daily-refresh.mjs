// scripts/daily-refresh.mjs
import fs from "node:fs/promises";
import { GoogleGenAI, Type } from "@google/genai";

const MODEL_NAME = "gemini-3.8-flash";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.GEMINI_API_KEY;
const DATA_PATH = "./data.json";

// Search queries used to auto-discover high-engagement GTA 6 YouTube videos daily
const CATEGORY_SEARCH_QUERIES = {
  cars: "GTA 6 best cars supercars lap time test tier list",
  weapons: "GTA 6 best weapons guns TTK damage test tier list",
  money: "GTA 6 best money methods solo guide per hour",
  gear: "GTA 6 best gear upgrades tools key cloner guide"
};

/**
 * Automatically finds YouTube videos with strong positive signals:
 * 1. Searches YouTube Data API v3 for recent/relevant videos in the category
 * 2. Checks viewCount, likeCount (like-to-view ratio), and commentCount
 * 3. Pulls top commentThreads to verify enthusiastic player feedback
 */
async function discoverHighSignalVideos(categoryQuery, maxResults = 3) {
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
        const cUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&maxResults=12&order=relevance&videoId=${encodeURIComponent(vid.id)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
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
    console.warn("YouTube Data API discovery fallback to Google Search Grounding:", err.message);
    return [];
  }
}

async function refreshCategory(category, existingItems) {
  const discoveredVideos = await discoverHighSignalVideos(CATEGORY_SEARCH_QUERIES[category], 3);
  console.log(`[${category}] Auto-discovered ${discoveredVideos.length} high-signal YouTube videos.`);

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [
      ...discoveredVideos.map((v) => ({
        fileData: { fileUri: v.url, mimeType: "video/mp4" }
      })),
      `You are the automated scoring engine for Meta Center (GTA 6).
       Update the rankings for category "${category}".
       Current items: ${JSON.stringify(existingItems.map(i => ({ id: i.id, name: i.name })))}
       Auto-discovered high-engagement YouTube videos & viewer comment sentiment: ${JSON.stringify(discoveredVideos)}
       1. Use Google Search to check GTA 6 guide sites (IGN, Kotaku, Inven Global, TechRadar) and recent patch notes.
       2. Watch the attached high-signal YouTube videos for visual stat bars, lap times, TTK tests, or money/hour numbers, and cross-check with the enthusiastic viewer comments.
       3. Return updated ranks for each item (rank 1 = 100 pts, each rank lower -6 pts down to 40). Include timestamp (MM:SS) for YouTube sources.`
    ],
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          patchNote: { type: Type.STRING, description: "Any new patch or balance change detected today" },
          updatedItems: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                blurb: { type: Type.STRING },
                ranks: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      source: { type: Type.STRING },
                      kind: { type: Type.STRING, description: "youtube or web" },
                      timestamp: { type: Type.STRING, description: "MM:SS if youtube" },
                      quote: { type: Type.STRING },
                      url: { type: Type.STRING },
                      rank: { type: Type.INTEGER }
                    },
                    required: ["source", "kind", "rank", "quote"]
                  }
                }
              },
              required: ["id", "ranks"]
            }
          }
        }
      }
    }
  });

  return JSON.parse(response.text);
}

async function maybeGenerateThreeDayArticle(data) {
  const lastPostDate = data.posts?.[0]?.published || "2026-11-01";
  const daysSince = (Date.now() - new Date(lastPostDate).getTime()) / (1000 * 3600 * 24);
  if (daysSince < 3 && process.env.FORCE_ARTICLE !== "true") {
    console.log(`Skipping article generation (${daysSince.toFixed(1)} days since last post).`);
    return null;
  }

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: `Research the newest GTA 6 meta shift, patch change, or hidden mechanic from the last 72 hours.
    RULE: You MUST find at least 3 distinct, credible sources (guide sites or high-engagement YouTube creator tests). If fewer than 3 solid sources exist, set "skipRun": true.
    Write in a crisp, authoritative gaming editorial voice (never mention AI). Use bracketed citations like [1], [2] inside the paragraph text pointing to the sources array.`,
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          skipRun: { type: Type.BOOLEAN },
          slug: { type: Type.STRING },
          title: { type: Type.STRING },
          dek: { type: Type.STRING },
          tags: { type: Type.ARRAY, items: { type: Type.STRING } },
          sections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                h: { type: Type.STRING },
                p: { type: Type.ARRAY, items: { type: Type.STRING } },
                list: { type: Type.ARRAY, items: { type: Type.STRING } }
              }
            }
          },
          sources: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                publisher: { type: Type.STRING },
                date: { type: Type.STRING },
                url: { type: Type.STRING }
              },
              required: ["title", "publisher", "url"]
            }
          }
        },
        required: ["skipRun"]
      }
    }
  });

  const article = JSON.parse(response.text);
  if (article.skipRun || (article.sources || []).length < 3) {
    console.log("Skipped article: fewer than 3 verified sources found.");
    return null;
  }
  return {
    slug: article.slug,
    title: article.title,
    dek: article.dek,
    author: "Meta Center Staff",
    published: new Date().toISOString().slice(0, 10),
    updated: new Date().toISOString().slice(0, 10),
    tags: article.tags || ["Meta"],
    sections: article.sections || [],
    sources: article.sources
  };
}

async function main() {
  const raw = await fs.readFile(DATA_PATH, "utf8");
  const data = JSON.parse(raw);
  const today = new Date().toISOString().slice(0, 10);

  for (const cat of Object.keys(data.categories)) {
    console.log(`Auto-discovering & refreshing category: ${cat}...`);
    const res = await refreshCategory(cat, data.categories[cat]);
    for (const upd of (res.updatedItems || [])) {
      const target = data.categories[cat].find(i => i.id === upd.id);
      if (target && upd.ranks?.length >= 2) {
        target.ranks = upd.ranks;
        if (upd.blurb) target.blurb = upd.blurb;
        target.sample = false;
      }
    }
    if (res.patchNote) {
      data.changelog.unshift({ date: today, text: res.patchNote });
    }
  }

  const newArticle = await maybeGenerateThreeDayArticle(data);
  if (newArticle) {
    data.posts.unshift(newArticle);
    data.changelog.unshift({ date: today, text: `Published feature guide: "${newArticle.title}" (${newArticle.sources.length} sources).` });
  }

  data.meta.updated = today;
  data.meta.newsSynced = today;
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log("Daily refresh complete!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
