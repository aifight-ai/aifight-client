// Evocative English display-name suggester (owner ruling 2026-06-18). Replaces
// the old `agent-direct-<host>-<hex>` slug with a "Dark Knight"-style name built
// from curated adjective + noun lists (~100 × ~100 ≈ 10⁴ combos), so a new agent
// starts with a nice, human display name that the user can keep or change later.
//
// The display name is a free-form, NON-unique label — NOT a username — so repeats
// are fine; the immutable numeric public ID disambiguates.
//
// Output guarantees: every suggestion is ASCII "Adjective Noun" (passes the
// server charset rule), 2–50 chars, and is re-screened against a mirror of the
// server's reserved-brand + profanity rules so a generated name never gets
// rejected at registration/rename. The word lists are pre-vetted clean; the
// screen is belt-and-suspenders.

const ADJECTIVES = [
  "Amber", "Arctic", "Ashen", "Astral", "Autumn", "Azure", "Bold", "Brave",
  "Bright", "Bronze", "Calm", "Cobalt", "Cosmic", "Crimson", "Crystal", "Dapper",
  "Daring", "Dark", "Dawn", "Deep", "Dusk", "Eager", "Ember", "Emerald",
  "Fabled", "Fearless", "Feral", "Fierce", "Flint", "Frost", "Gallant", "Gentle",
  "Gilded", "Golden", "Granite", "Grave", "Hidden", "Hollow", "Humble", "Icy",
  "Iron", "Ivory", "Jade", "Keen", "Lone", "Lucky", "Lunar", "Marble",
  "Midnight", "Mighty", "Misty", "Mystic", "Noble", "Nimble", "Obsidian", "Onyx",
  "Pale", "Phantom", "Polar", "Primal", "Quiet", "Radiant", "Rapid", "Restless",
  "Rogue", "Royal", "Ruby", "Rugged", "Sable", "Sapphire", "Savage", "Scarlet",
  "Secret", "Shadow", "Silent", "Silver", "Sly", "Solar", "Solemn", "Stark",
  "Steel", "Stoic", "Storm", "Sublime", "Swift", "Tidal", "Timber", "Twilight",
  "Umbral", "Valiant", "Velvet", "Verdant", "Vivid", "Wandering", "Wild", "Winter",
  "Wise", "Zephyr",
];

const NOUNS = [
  "Albatross", "Antler", "Arrow", "Aurora", "Badger", "Banner", "Basilisk", "Beacon",
  "Bear", "Bishop", "Bison", "Blade", "Boulder", "Cipher", "Citadel", "Comet",
  "Compass", "Condor", "Cougar", "Crane", "Crow", "Dagger", "Dragon", "Drifter",
  "Eagle", "Ember", "Falcon", "Fang", "Fox", "Gambit", "Glacier", "Griffin",
  "Harbor", "Hawk", "Heron", "Hunter", "Jackal", "Jaguar", "Kestrel", "Knight",
  "Kraken", "Lantern", "Leopard", "Lion", "Lotus", "Lynx", "Mantis", "Marauder",
  "Mariner", "Maverick", "Meridian", "Monarch", "Mongoose", "Nomad", "Oracle", "Osprey",
  "Otter", "Panther", "Pilgrim", "Pioneer", "Puma", "Quarry", "Raven", "Reaper",
  "Ronin", "Rook", "Sage", "Sentinel", "Seraph", "Serpent", "Shark", "Sparrow",
  "Specter", "Sphinx", "Spire", "Stag", "Stallion", "Stranger", "Summit", "Talon",
  "Tempest", "Thorn", "Tiger", "Titan", "Torrent", "Tundra", "Valkyrie", "Vanguard",
  "Viper", "Voyager", "Warden", "Watcher", "Whisper", "Wolf", "Wraith", "Wyvern",
  "Yak", "Zenith",
];

// Mirror of the server's reserved-brand + profanity rules, just enough to
// guarantee clean output. The authoritative gate is internal/agentname on the
// server; this MUST follow the same structure or the generator could emit a name
// the server then rejects (or needlessly reject a fine one):
//   - FRAGMENTS  → matched as a substring of the glued name (long brand terms only)
//   - PREFIXES   → matched at the start of the glued name
//   - TOKENS     → matched only as a WHOLE space/_/- separated word
// Short terms (meta, gpt, aws, xai, x) are tokens/prefixes — NEVER substrings —
// exactly because substring-matching them flags innocent words ("Sublime Talon"
// glues to "...metal...").
const RESERVED_FRAGMENTS = [
  "aifight", "openai", "chatgpt", "anthropic", "claude", "google", "gemini",
  "deepmind", "deepseek", "apple", "microsoft", "github", "openclaw", "qclaw",
  "hermes", "facebook", "amazon", "nvidia", "tesla", "twitter", "linkedin",
  "discord", "telegram", "feishu", "bytedance", "tiktok", "mistral", "perplexity",
  "grok", "llama", "qwen", "kimi", "minimax", "zhipu", "glm", "openrouter",
  "huggingface", "stability", "midjourney", "cohere", "replicate", "together",
  "groq", "resend", "sendgrid",
];

const RESERVED_PREFIXES = ["gpt", "aws", "xai"];

const RESERVED_TOKENS = new Set([
  "aifight", "admin", "root", "system", "support", "staff", "official",
  "verified", "moderator", "meta", "x", "codex", "gpt", "aws", "xai",
]);

// Profanity is matched as a substring for these (long, unambiguous) terms. The
// server additionally blocks short whole-token obscenities (ass/cum/…), but the
// curated word lists contain no such tokens, so the substring set suffices here.
const PROFANITY_FRAGMENTS = [
  "nigger", "nigga", "faggot", "chink", "spic", "kike", "coon", "wetback",
  "tranny", "gook", "beaner", "fuck", "shit", "bitch", "whore", "pussy",
  "asshole", "motherf", "jizz", "wank", "cumshot", "dickhead", "caonima",
  "shabi", "nmsl", "wocao",
];

function isCleanWord(name: string): boolean {
  const tokens = name.toLowerCase().split(/[\s_-]+/).filter((t) => t.length > 0);
  const compact = tokens.join("");
  if (compact === "") return false;
  for (const token of tokens) {
    if (RESERVED_TOKENS.has(token)) return false;
  }
  for (const frag of RESERVED_FRAGMENTS) {
    if (compact.includes(frag)) return false;
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (compact.startsWith(prefix)) return false;
  }
  for (const frag of PROFANITY_FRAGMENTS) {
    if (compact.includes(frag)) return false;
  }
  return true;
}

function pick<T>(list: readonly T[], rand: () => number): T {
  return list[Math.floor(rand() * list.length)]!;
}

/**
 * Returns an evocative "Adjective Noun" display name. `rand` is injectable for
 * deterministic tests; it defaults to Math.random. Guaranteed to be a valid,
 * clean public display name.
 */
export function generateSuggestedName(rand: () => number = Math.random): string {
  for (let i = 0; i < 50; i++) {
    const candidate = `${pick(ADJECTIVES, rand)} ${pick(NOUNS, rand)}`;
    if (candidate.length >= 2 && candidate.length <= 50 && isCleanWord(candidate)) {
      return candidate;
    }
  }
  // Pathological fallback (lists are curated so this is unreachable in practice).
  return "Silent Fox";
}

// Exported for tests that assert every word-list entry survives the screen.
export const _ADJECTIVES = ADJECTIVES;
export const _NOUNS = NOUNS;
export const _isCleanWord = isCleanWord;
