# Beat Six content schema

The site (`index.html`) reads everything from `data.json`. The gathering job (`daily-refresh.mjs`, Gemini) writes it.
The page never writes `data.json`. This file is the contract between the two.

Existing keys (`meta`, `categories`, `news`, `posts`, `changelog`) are unchanged.
Two **optional** keys power the new Search and Discover sections. If they are missing or empty,
the site still works: Discover builds starter lists from `categories` and `news`, and Search indexes
everything that already exists.

## `guides` (powers Search)

Answers to specific questions: how to level a stat, how to beat a mission, where to find something.
These rank highest in search results.

```json
"guides": [
  {
    "id": "level-up-stamina",
    "title": "How to level up stamina fast",
    "summary": "One or two sentences that answer the question directly.",
    "tags": ["Stats", "Stamina", "Early game"],
    "steps": [
      "Each step is one plain sentence.",
      "Steps render as a numbered how-to."
    ],
    "sources": [
      {
        "title": "Exact title of the video or article",
        "publisher": "Creator or site name",
        "url": "https://… (must be https and must be the real page)",
        "kind": "youtube",
        "timestamp": "04:12",
        "date": "2026-11-20"
      }
    ],
    "updated": "2026-11-20"
  }
]
```

Good targets: every story mission (`"tags": ["Mission"]`), every stat (stamina, shooting, driving, flying, stealth,
strength, lung capacity), collectibles, unlock locations, heist prep steps.

## `lists` (powers Discover)

Lists of what to do. `kind` decides how it renders:
- `"checklist"`: steps in order with checkboxes the player can tick off (progress is saved on their device).
- `"ranked"`: numbered best-to-worst picks.

```json
"lists": [
  {
    "id": "best-heists",
    "title": "The most lucrative heists, ranked",
    "dek": "One line on what the list is for.",
    "kind": "ranked",
    "stage": "Heists",
    "entries": [
      {
        "title": "Entry name",
        "body": "One or two sentences on why it's here.",
        "where": "Where or how to start it (optional)",
        "ref": "money/money-heist-setup-vault-jobs",
        "source": { "name": "Creator or site", "url": "https://…" }
      }
    ],
    "updated": "2026-11-20"
  }
]
```

- `ref` is optional. Set it to `category/item-id` to link an entry to its Meta page.
- A list from `data.lists` with the same `id` as a built-in starter list replaces it.
  Starter list ids: `early-game`, `money-makers`, `car-theft`, `combat-basics`, `fastest-rides`, `secrets`.
- Lists with fewer than two entries are hidden.

## Rules that keep the site trustworthy

- Every `url` must be the actual page the fact came from. Never a channel homepage or a placeholder video.
- Never invent quotes or timestamps. If a source has no quote, leave `quote` out.
- `rank` values in `categories[*].ranks` must come from a real ranking in that source.
