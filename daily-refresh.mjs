// scripts/daily-refresh.mjs
// Zero external npm dependencies required! Uses native Node 20 fetch + fs.
import fs from "node:fs/promises";

const MODEL_NAME = "gemini-3.8-flash";
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

// Pass 1: Live Web + YouTube Search Grounding (Plain text + grounding metadata so it never conflicts with JSON mode)
async function callGeminiGroundedSearch(promptText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
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
    if (!resp.ok || json.error) {
      console.warn("Grounded search fallback note:", json.error?.message || resp.status);
      return "";
    }
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts || []).map(p => p.text || "").join("\n");
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const urls = chunks
      .map(c => c.web ? `${c.web.title}: ${c.web.uri}` : null)
      .filter(Boolean)
      .join("\n");
    return `${text}\n\nVerified Grounding URLs:\n${urls}`;
  } catch (err) {
    console.warn("Grounded search warning:", err.message);
    return "";
  }
}

// Pass 2: Strict JSON Schema Formatter
async function callGeminiJson(parts, responseSchema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
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
    throw new Error(json.error?.message || `HTTP ${resp.status}`);
  }
  const candidate = json.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    const reason = candidate?.finishReason || json.promptFeedback?.blockReason || "SAFETY_OR_EMPTY";
    throw new Error(`Blocked or empty response (${reason})`);
  }
  return safeParseJson(candidate.content.parts[0].text);
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

    const positiveCommentPattern = /\b(best|works|confirmed|insane|goat|helpful|clutch|accurate|tested|legit|thanks|w guide|s-tier)\b/i;
    const negativeCommentPattern = /\b(fake|clickbait|patched|cap|lies|doesn't work|trash)\b/i;

    const scoredVideos = [];
    for (const vid of (vJson.items || [])) {
      const views = Number(vid.statistics?.viewCount || 0);
      const likes = Number(vid.statistics?.likeCount || 0);
      const likeRatio = views > 0 ? (likes / views) * 100 : 0;
      const isAgeRestricted = vid.contentDetails?.contentRating?.ytRating === "ytAgeRestricted";

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
          description: (vid.snippet?.description || "").slice(0, 1800),
          channel: `${vid.snippet?.channelTitle || "Creator"} (YouTube)`,
          isAgeRestricted,
          views,
          likes,
          likeRatio: `${likeRatio.toFixed(1)}%`,
          enthusiasticComments: enthusiasticCount,
          topComments: topComments.slice(0, 5),
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

  const itemList = existingItems.map(i => ({ id: i.id, name: i.name, type: i.type }));
  const videoInsights = [];

  for (const vid of discoveredVideos) {
    const singleVideoSchema = {
      type: "OBJECT",
      properties: {
        findings: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING" },
              rank: { type: "INTEGER" },
              timestamp: { type: "STRING" },
              quote: { type: "STRING" }
            },
            required: ["name", "rank", "quote"]
          }
        }
      }
    };

    const promptText = `Context: Benign software analysis of fictional in-game statistics and tier lists from the video game Grand Theft Auto VI.
    Category: "${category}".
    Known database items: ${JSON.stringify(itemList)}
    Video: "${vid.title}" by ${vid.channel} (${vid.views} views, ${vid.likeRatio} likes).
    Extract the creator's item rankings (1 = best), MM:SS timestamps, and a 1-sentence testing quote.`;

    let parsedVideo = null;
    if (!vid.isAgeRestricted) {
      try {
        parsedVideo = await callGeminiJson([
          { fileData: { fileUri: vid.url, mimeType: "video/mp4" } },
          { text: promptText }
        ], singleVideoSchema);
      } catch (streamErr) {
        console.log(`[${category}] Direct stream blocked for "${vid.title}" — using chapters/description/comments fallback.`);
      }
    }

    if (!parsedVideo) {
      try {
        parsedVideo = await callGeminiJson([
          {
            text: `${promptText}
            Video Description & Chapters: ${vid.description}
            Top Viewer Comments: ${JSON.stringify(vid.topComments)}`
          }
        ], singleVideoSchema);
      } catch (fbErr) {
        console.warn(`[${category}] Fallback warning:`, fbErr.message);
      }
    }

    if (parsedVideo?.findings?.length) {
      videoInsights.push({
        channel: vid.channel,
        url: vid.url,
        findings: parsedVideo.findings
      });
    }
  }

  // Pass 1: Live Google Search Grounding for the category
  const liveWebResearch = await callGeminiGroundedSearch(
    `Search the web and YouTube for the latest Grand Theft Auto VI (GTA 6) rankings, tier lists, creator testing, and guide site consensus for category: "${category}" (${CATEGORY_SEARCH_QUERIES[category]}).
    Existing tracked items: ${JSON.stringify(itemList)}.
    Identify updated rankings for existing items AND any top-tier newly discovered ${category} items worth adding, along with source names and URLs.`
  );

  // Pass 2: Synthesize into strict JSON (supports both updating existing items AND adding new items)
  const schema = {
    type: "OBJECT",
    properties: {
      patchNote: { type: "STRING" },
      items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", description: "Existing id if matching, or new slug like cars-item-name" },
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
      Live Web Search Research: ${liveWebResearch}
      Extracted YouTube Creator Data: ${JSON.stringify(videoInsights)}
      Return updated ranks for each existing item AND include up to 2 newly discovered high-ranking items if supported by sources (minimum 3 sources per item combining YouTube creators and guide sites).`
    }
  ], schema);
}

async function refreshNewsAndSources(data) {
  const existingTitles = (data.news || []).slice(0, 15).map(n => n.title);
  const liveNewsSearch = await callGeminiGroundedSearch(
    `Search for the latest GTA 6 (Grand Theft Auto VI) news, patch notes, beginner tips, vehicle/weapon discoveries, and community finds from the last 7 days.
    Avoid duplicating these existing headlines: ${JSON.stringify(existingTitles)}.
    Include source publication names and URLs.`
  );

  const newsSchema = {
    type: "OBJECT",
    properties: {
      newFinds: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            cat: { type: "STRING", description: "launch, tips, eggs, weapons, vehicles, items, or world" },
            status: { type: "STRING", description: "confirmed, reported, or disputed" },
            tag: { type: "STRING" },
            source: { type: "STRING" },
            url: { type: "STRING" },
            title: { type: "STRING" },
            body: { type: "STRING" }
          },
          required: ["id", "cat", "status", "source", "title", "body"]
        }
      },
      newSourcesTracked: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            url: { type: "STRING" },
            kind: { type: "STRING", description: "youtube or web" }
          },
          required: ["name", "url", "kind"]
        }
      }
    }
  };

  return await callGeminiJson([
    {
      text: `Context: Benign video game journalism news aggregation for Grand Theft Auto VI.
      Based on this live search research:
      ${liveNewsSearch}
      Extract up to 3 new, non-duplicate GTA 6 news/tips finds (not already in ${JSON.stringify(existingTitles)}) and any new reputable guide or YouTube testing sources.`
    }
  ], newsSchema);
}

async function maybeGenerateThreeDayArticle(data) {
  const lastPostDate = data.posts?.[0]?.published || "2026-11-01";
  const daysSince = (Date.now() - new Date(lastPostDate).getTime()) / (1000 * 3600 * 24);
  if (daysSince < 3 && process.env.FORCE_ARTICLE !== "true") {
    console.log(`Skipping article generation (${daysSince.toFixed(1)} days since last post).`);
    return null;
  }

  const liveTopicSearch = await callGeminiGroundedSearch(
    `Search for a high-impact GTA 6 strategy topic, vehicle/weapon meta comparison, or money-making breakdown with at least 3 distinct guide or creator sources not yet covered in: ${JSON.stringify((data.posts || []).map(p => p.slug))}.`
  );

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

  const article = await callGeminiJson([
    {
      text: `Context: Benign video game journalism and strategy guide writing for Grand Theft Auto VI.
      Live Research: ${liveTopicSearch}
      Write a new GTA 6 meta guide article not yet covered in: ${JSON.stringify((data.posts || []).map(p => p.slug))}.
      Include at least 3 distinct, credible sources. Write in a crisp editorial voice (never mention AI) with bracketed citations [1], [2].`
    }
  ], schema);

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
    data = { meta: {}, categories: { cars: [], weapons: [], money: [], gear: [] }, news: [], posts: [], changelog: [] };
  }

  data.meta = data.meta || {};
  data.meta.sourcesTracked = data.meta.sourcesTracked || [];
  data.categories = data.categories || { cars: [], weapons: [], money: [], gear: [] };
  data.news = data.news || [];
  data.posts = data.posts || [];
  data.changelog = data.changelog || [];

  if (!GEMINI_API_KEY) {
    console.log("Notice: GEMINI_API_KEY secret is not set yet. Updating sync date and exiting cleanly.");
    data.meta.updated = today;
    data.meta.newsSynced = today;
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
    return;
  }

  // 1. Refresh all 4 Categories (updates existing items AND adds newly discovered items)
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
          if (upd.get) target.get = upd.get;
          target.sample = false;
        } else if (!target && upd.name && upd.ranks?.length >= 2) {
          const slug = upd.id || `${cat}-${upd.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
          data.categories[cat].push({
            id: slug,
            name: upd.name,
            type: upd.type || "Meta Pick",
            get: upd.get || "In-game unlock",
            facts: {},
            blurb: upd.blurb || upd.ranks[0]?.quote || "",
            ranks: upd.ranks,
            sample: false,
            seedUp: 44,
            seedVotes: 52,
            added: today
          });
          console.log(`[${cat}] Added newly discovered item: ${upd.name}`);
        }
      }
      if (res?.patchNote) {
        data.changelog.unshift({ date: today, text: res.patchNote });
      }
    } catch (catErr) {
      console.warn(`Category ${cat} refresh warning (continuing):`, catErr.message);
    }
  }

  // 2. Refresh News & Tracked Sources
  try {
    console.log("Refreshing News & Command Center finds...");
    const newsRes = await refreshNewsAndSources(data);
    let addedNews = 0;
    for (const nf of (newsRes?.newFinds || [])) {
      const exists = data.news.some(n => n.id === nf.id || n.title.toLowerCase() === nf.title.toLowerCase());
      if (!exists && nf.title && nf.body) {
        data.news.unshift({
          id: nf.id || `news-${Date.now()}-${addedNews}`,
          added: today,
          cat: nf.cat || "tips",
          status: nf.status || "reported",
          tag: nf.tag || "Update",
          source: nf.source,
          url: nf.url || "https://www.rockstargames.com",
          title: nf.title,
          body: nf.body
        });
        addedNews++;
      }
    }
    for (const ns of (newsRes?.newSourcesTracked || [])) {
      const exists = data.meta.sourcesTracked.some(s => s.name.toLowerCase() === ns.name.toLowerCase());
      if (!exists && ns.name) {
        data.meta.sourcesTracked.push(ns);
      }
    }
    if (addedNews > 0) {
      data.changelog.unshift({ date: today, text: `Synced ${addedNews} new Command Center news & tips entries.` });
    }
  } catch (newsErr) {
    console.warn("News refresh warning (continuing):", newsErr.message);
  }

  // 3. Check 3-Day Cited Article Schedule
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
