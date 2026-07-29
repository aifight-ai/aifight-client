// D6.5 — the "your agent" private-view strip. Desktop-only, purely additive
// (no website code touched). It surfaces the OWNER's own private info pulled
// from action_request.state: poker hole cards, liar's-dice faces, coup hidden
// influence + coins. The website's board renderer has no slot for "the viewer's
// own secrets" (the site is always a spectator), so this strip is how the
// cockpit honors "show me my own agent's hidden info" for every game.
//
// 🔒 It renders ONLY the owner's own info — never an opponent's. The shape it
// receives (OwnerPrivate) can only ever carry the owner's fields.

import { useTranslation } from "react-i18next";

import type { Game, OwnerPrivate } from "../liveMatch";

const SUIT_GLYPH: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const DICE_PIP = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const ROLE_CLASS: Record<string, string> = {
  Duke: "text-blue-400 border-blue-500/30 bg-blue-500/10",
  Assassin: "text-red-400 border-red-500/30 bg-red-500/10",
  Captain: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
  Ambassador: "text-green-400 border-green-500/30 bg-green-500/10",
  Contessa: "text-pink-400 border-pink-500/30 bg-pink-500/10",
};

function PlayingCard({ card }: { card: string }) {
  const raw = card.slice(0, card.length - 1);
  // Engine notation writes Ten as "T"; people read "10" (and the board's seat
  // cards already say 10) — normalize so the two never disagree on screen.
  const rank = raw === "T" ? "10" : raw;
  const suit = card.slice(-1).toLowerCase();
  const red = suit === "h" || suit === "d";
  return (
    <span className={"v3-big" + (red ? " rd" : "")}>
      <span className="rk">{rank}</span>
      <span className="st">{SUIT_GLYPH[suit] ?? suit}</span>
    </span>
  );
}

function hasAny(owner: OwnerPrivate): boolean {
  return Boolean(
    (owner.holeCards && owner.holeCards.length) ||
      (owner.dice && owner.dice.length) ||
      (owner.influence && owner.influence.length) ||
      (owner.revealed && owner.revealed.length) ||
      owner.coins !== undefined ||
      owner.chips !== undefined,
  );
}

export function OwnHandStrip({ game, owner }: { game: Game; owner: OwnerPrivate }) {
  const { t } = useTranslation();

  return (
    <div className="v3-own">
      <span className="v3-own-label">{t("cockpit.yourAgent")}</span>

      {!hasAny(owner) && <span className="v3-own-empty">{t("cockpit.noPrivateInfo")}</span>}

      {game === "texas_holdem" && owner.holeCards && owner.holeCards.length > 0 && (
        <span className="v3-own-cards">
          {owner.holeCards.map((c, i) => (
            <PlayingCard key={`${c}-${i}`} card={c} />
          ))}
        </span>
      )}

      {game === "liars_dice" && owner.dice && owner.dice.length > 0 && (
        <span className="v3-own-dice">
          {owner.dice.map((d, i) => (
            <span key={i} title={String(d)}>
              {DICE_PIP[d] ?? d}
            </span>
          ))}
        </span>
      )}

      {game === "coup" && (
        <span className="v3-own-roles">
          {/* Full role names — the old 36px squares truncated to "Duk"/"Amb",
              which read as codes, not roles (owner walkthrough 2026-07-28). */}
          {(owner.influence ?? []).map((r, i) => (
            <span
              key={`h-${i}`}
              className={`inline-flex h-9 items-center justify-center rounded-md border px-2.5 text-[10px] font-bold ${
                ROLE_CLASS[r] ?? "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
              }`}
            >
              {r}
            </span>
          ))}
          {(owner.revealed ?? []).map((r, i) => (
            <span
              key={`r-${i}`}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[10px] font-bold text-[var(--text-faint)] line-through"
            >
              {r}
            </span>
          ))}
        </span>
      )}

      {/* Numeric chips/coins, shown to the right when present. */}
      {owner.chips !== undefined && (
        <span className="v3-own-meta">
          {t("cockpit.chips")} <b>{owner.chips}</b>
        </span>
      )}
      {owner.coins !== undefined && (
        <span className="v3-own-meta">
          {t("cockpit.coins")} <b>{owner.coins}</b>
        </span>
      )}
    </div>
  );
}
