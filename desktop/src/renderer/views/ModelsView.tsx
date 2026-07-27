// D8 / D8.6 / D8.7 — Models: the GRAPHICAL, standalone LLM config editor,
// organized by the 4 API PROTOCOL FAMILIES (not by provider/model). A user
// installs the app and configures direct-LLM mode entirely here — pick a
// protocol, set model/endpoint, paste a key, tune temperature/maxTokens/
// streaming/reasoning, test — never touching the CLI.
//
// The per-model reasoning specifics (which thinking shape, which effort tiers, what
// output ceiling) are auto-detected from the model id — there's no manual variant
// switch. This view does NOT keep its own table of that: it asks the capability
// registry over IPC (llmModelCapabilities), the same source the adapters and the CLI
// read, and shows the answer so the user can see what will be sent. Tiers render as
// clickable chips (closed set + auto, default high — owner decision 2026-07-26);
// the registry only annotates, so a tier the model doesn't list stays clickable
// with a "sent as …" note instead of disappearing.
//
// Reads/writes the SAME agent config.json the CLI uses (config:* IPC); pasted
// keys → 0600 file in main. Fully bilingual (zh/en).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw, KeyRound, Check, X, Plus, Trash2, Zap, Star } from "lucide-react";

import {
  runCli,
  getLLMConfig,
  llmRecommendMaxTokens,
  llmModelCapabilities,
  llmDiscoverModels,
  saveLLMProfile,
  setLLMKey,
  clearLLMKey,
  setLLMActive,
  setLLMRoute,
  deleteLLMProfile,
} from "../useBridge";
import { localizeServerError } from "../errors";
import { PageHeader } from "../components/ui";
import { useLiveGames } from "../liveGames";
import { gameLabel } from "../../shared/games";
import type { ConfigProfileView, ConfigView, ModelCapabilitiesResult, ProfileInput, ProtocolFamily } from "../../shared/ipc";
import { ConfigBrokenBanner, configPageState } from "./ConfigBrokenBanner";
interface FamilyDef {
  key: ProtocolFamily;
  label: string;
  models: string[]; // current suggestions (datalist), editable
  baseURLPlaceholderKey: string;
}
// Static model seeds are only the PRE-KEY fallback: once a key is present, the
// "fetch model list" button asks the provider itself (llmDiscoverModels) and the
// live answer replaces these. A hardcoded list is stale the week it ships.
const FAMILIES: FamilyDef[] = [
  { key: "anthropic", label: "Anthropic (Messages)", models: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"], baseURLPlaceholderKey: "models.baseUrlAnthropic" },
  { key: "openai_responses", label: "OpenAI Responses", models: ["gpt-5.6-sol", "gpt-5.6", "gpt-5.5", "gpt-5.4"], baseURLPlaceholderKey: "models.baseUrlOpenai" },
  { key: "openai_chat", label: "OpenAI Chat 兼容 (DeepSeek / custom)", models: ["deepseek-v4-pro", "deepseek-v4-flash", "gpt-5.6-sol", "gpt-4o"], baseURLPlaceholderKey: "models.baseUrlChat" },
  { key: "gemini", label: "Gemini (generateContent)", models: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash"], baseURLPlaceholderKey: "models.baseUrlGemini" },
];
function familyDef(key: ProtocolFamily): FamilyDef {
  return FAMILIES.find((f) => f.key === key) ?? FAMILIES[0];
}

// Effort tiers are NOT listed here. They come from the capability registry over
// IPC (llmModelCapabilities → model-capabilities.json), the same source the
// adapters and the CLI read. A UI-local mirror of that table is precisely how this
// editor ended up offering only low/medium/high for claude-opus-5 — a model that
// takes all five tiers — while `aifight config` offered the full ladder. And
// because registry tiers are SUGGESTIONS rather than a whitelist, a model newer
// than this build stays configurable: the field accepts any typed value.

/**
 * What (if anything) is wrong with a typed effort. Two distinct outcomes, so two
 * distinct answers:
 *   unstorable — config.json's schema rejects it, so Save must be blocked
 *   clamped    — storable, but this model doesn't list it, so the adapter will
 *                lower it to high; worth saying, not worth blocking
 * A model the registry doesn't list has no per-model opinion, so only the storable
 * check applies. Exported for the unit test.
 */
export function classifyEffort(
  effort: string,
  caps: ModelCapabilitiesResult | null,
): { blocking: boolean; kind: "unstorable" | "clamped" } | null {
  const v = effort.trim();
  if (v === "" || v === "auto" || caps === null) return null; // auto = provider default, valid everywhere
  if (!caps.storableEfforts.includes(v)) return { blocking: true, kind: "unstorable" };
  if (caps.isKnownModel && caps.efforts.length > 0 && !caps.efforts.includes(v)) {
    return { blocking: false, kind: "clamped" };
  }
  return null;
}

/**
 * Which VALUE editor the reasoning row shows. Budget-shaped models (the Anthropic
 * 4.5 generation's budget_tokens, Gemini 2.5's thinkingBudget) take a token
 * NUMBER; everything else takes a tier. This mirrors the admin panel's
 * "推理控制方式" split, derived from the registry instead of chosen by hand.
 */
export function reasoningShape(
  family: ProtocolFamily,
  caps: ModelCapabilitiesResult | null,
): "tiers" | "budget" {
  if (caps === null) return "tiers";
  if (family === "anthropic" && caps.thinkingModes.length > 0 && !caps.thinkingModes.includes("adaptive")) return "budget";
  if (family === "gemini" && caps.thinkingParam === "thinkingBudget") return "budget";
  return "tiers";
}

const TIER_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Same presets the Go side offers (llmcompat BudgetPresetDefaults). */
const BUDGET_PRESETS = [1024, 4096, 8192, 32768] as const;

/**
 * The pickable tier chips: the PROTOCOL vocabulary (∪ the model's own list, so a
 * registry gap can never hide a tier the model has), in canonical order, with
 * "auto" always first. The per-model list only ANNOTATES — a chip the model
 * doesn't list stays clickable and the adapter clamps it (owner decision D2:
 * max renders on gpt-5.5 with a "sent as xhigh" note rather than disappearing).
 */
export function tierChips(caps: ModelCapabilitiesResult | null): string[] {
  const vocab = new Set<string>([...(caps?.protocolEfforts ?? []), ...(caps?.efforts ?? [])]);
  const ordered = TIER_ORDER.filter((tier) => vocab.has(tier));
  // No registry answer at all (blank model / unknown protocol): core five.
  const body = ordered.length > 0 ? ordered : ["low", "medium", "high", "xhigh", "max"];
  return ["auto", ...body];
}

/** Model-specific OPT-IN special toggles (off by default; only shown for models that support them). */
function specialFeatures(family: ProtocolFamily, model: string): { key: string; labelKey: string }[] {
  const m = model.toLowerCase();
  const out: { key: string; labelKey: string }[] = [];
  if (family === "openai_chat" && /deepseek-v4/.test(m)) {
    out.push({ key: "jsonObjectMode", labelKey: "models.featDeepseekJson" });
  }
  return out;
}

/** Human-readable "what will be sent", from the model id (for the auto-detect hint). */
function detectHint(
  t: (k: string) => string,
  family: ProtocolFamily,
  model: string,
  caps: ModelCapabilitiesResult | null,
): string {
  const m = model.toLowerCase();
  if (!model.trim()) return "";
  if (family === "anthropic") {
    // Which thinking shape gets sent is the registry's call (see the adapter's
    // thinkingShapeFor), so report ITS answer rather than re-deriving one here —
    // a hint that disagrees with the wire is worse than no hint.
    if (caps === null) return "";
    if (caps.thinkingModes.includes("adaptive")) return t("models.detAnthropicAdaptive");
    if (caps.thinkingModes.includes("extended")) return t("models.detAnthropicLegacy");
    return t("models.detAnthropicUnlisted");
  }
  if (family === "openai_responses") return t("models.detResponses");
  if (family === "openai_chat") return /deepseek/.test(m) ? t("models.detDeepseek") : t("models.detChatPassthrough");
  if (family === "gemini") {
    if (caps === null) return "";
    if (caps.thinkingParam === "thinkingBudget") return t("models.detGemini25");
    return caps.isKnownModel ? t("models.detGemini3") : t("models.detGeminiUnlisted");
  }
  return "";
}

interface FormState {
  profileId: string;
  isNew: boolean;
  displayName: string;
  family: ProtocolFamily;
  model: string;
  baseURL: string;
  temperature: string;
  maxTokens: string;
  requestTimeoutSec: string;
  stream: "auto" | "always" | "never";
  thinkingEnabled: boolean;
  effort: string;
  /** Manual thinking budget (budget-shaped models only), as typed. */
  budgetTokens: string;
  verbosity: string;
  features: Record<string, boolean>;
  apiKey: string;
}

function blankForm(family: ProtocolFamily): FormState {
  return {
    profileId: "",
    isNew: true,
    displayName: "",
    family,
    model: "",
    baseURL: "",
    temperature: "",
    // AIFight is a reasoning arena, so default to generous output room; unified
    // with the CLI wizard's 32000 default (D16). You pay for tokens used, not the cap.
    maxTokens: "32000",
    // Per-call request timeout in seconds; the 270 default keeps a 30s submit
    // margin inside the 300s turn.
    requestTimeoutSec: "270",
    stream: "auto",
    // Chat-family endpoints proxy arbitrary models that may not reason at all, so
    // their toggle starts OFF (a forwarded reasoning_effort would 400 on gpt-4o);
    // every real reasoning protocol starts ON.
    thinkingEnabled: family !== "openai_chat",
    // Owner decision 2026-07-26: the default tier is an explicit "high", visibly
    // selected and clickable — not a blank that quietly means "whatever the
    // provider does". "auto" remains available as a deliberate choice.
    effort: "high",
    budgetTokens: "",
    verbosity: "",
    features: {},
    apiKey: "",
  };
}

export function ModelsView() {
  const { t } = useTranslation();
  // Per-game routing rows follow the PLATFORM's live list (backend-fed).
  const games = useLiveGames();
  const [view, setView] = useState<ConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  // Per-profile test outcome: ok drives the green/red color; msg keeps the
  // provider's own detail (e.g. "invalid x-api-key") — that detail IS the point
  // of Test, so it isn't collapsed to a generic string.
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  // Two-click guard for the destructive "clear key" (deletes the 0600 key file).
  const [confirmClearId, setConfirmClearId] = useState<string | null>(null);

  // Capabilities live in the PARENT because save() needs them too (budget vs tier
  // shape decides what maxReasoningTokens to send); ProfileForm gets them as a prop.
  const caps = useModelCapabilities(form?.family ?? "anthropic", form?.model ?? "");

  const load = () => {
    setLoading(true);
    void getLLMConfig().then((v) => {
      setView(v);
      setLoading(false);
    });
  };
  useEffect(load, []);

  const openAdd = (family: ProtocolFamily) => {
    const f = blankForm(family);
    f.model = familyDef(family).models[0] ?? "";
    f.profileId = family === "openai_chat" ? "" : family;
    f.displayName = familyDef(family).label;
    setError(null);
    setForm(f);
  };

  const openEdit = (p: ConfigProfileView) => {
    setError(null);
    // Drop any stale test result — once the user edits the key/model, an old
    // "OK"/"failed" chip no longer reflects what's configured.
    setTestResult((prev) => {
      const next = { ...prev };
      delete next[p.id];
      return next;
    });
    setForm({
      profileId: p.id,
      isNew: false,
      displayName: p.displayName,
      family: p.family,
      model: p.model,
      baseURL: p.baseURL ?? "",
      temperature: p.temperature === null ? "" : String(p.temperature),
      maxTokens: String(p.maxTokens),
      requestTimeoutSec: p.requestTimeoutMs !== null ? String(Math.round(p.requestTimeoutMs / 1000)) : "270",
      stream: p.stream,
      thinkingEnabled: p.thinkingEnabled,
      // A stored profile with no tier means "provider default" — surface that as
      // the auto chip rather than an empty control.
      effort: p.effort ?? "auto",
      budgetTokens: p.maxReasoningTokens !== null ? String(p.maxReasoningTokens) : "",
      verbosity: p.verbosity ?? "",
      features: { ...p.features },
      apiKey: "",
    });
  };

  const save = async () => {
    if (form === null) return;
    const id = form.profileId.trim() || form.family;
    // Block a NEW profile from silently overwriting an existing one with the same
    // id (e.g. two Anthropic profiles both defaulting to "anthropic").
    if (form.isNew && (view?.profiles ?? []).some((p) => p.id === id)) {
      setError(t("models.idTaken"));
      return;
    }
    const rtRaw = form.requestTimeoutSec.trim();
    if (rtRaw !== "") {
      const rtSec = Number(rtRaw);
      // The runtime schema rejects requestMs outside [1s, 300s] when it loads
      // the profile — without this check the save succeeds but the agent then
      // silently fails to start. Same bounds as the CLI's --request-timeout.
      if (!Number.isInteger(rtSec) || rtSec < 1 || rtSec > 300) {
        setError(t("models.requestTimeoutRange"));
        return;
      }
    }
    setSaving(true);
    setError(null);
    const temp = form.temperature.trim() === "" ? null : Number(form.temperature);
    const input: ProfileInput = {
      profileId: id,
      displayName: form.displayName,
      family: form.family,
      model: form.model,
      baseURL: form.baseURL,
      thinkingEnabled: form.thinkingEnabled,
      ...(form.effort ? { effort: form.effort } : {}),
      // Budget only means something on budget-shaped models; anywhere else send
      // null so a stale budget doesn't ride along when the model changes.
      maxReasoningTokens:
        reasoningShape(form.family, caps) === "budget" && Number(form.budgetTokens) > 0
          ? Math.floor(Number(form.budgetTokens))
          : null,
      temperature: temp !== null && Number.isFinite(temp) ? temp : null,
      ...(form.maxTokens.trim() !== "" && Number(form.maxTokens) > 0 ? { maxTokens: Number(form.maxTokens) } : {}),
      ...(form.requestTimeoutSec.trim() !== "" && Number(form.requestTimeoutSec) > 0
        ? { requestTimeoutMs: Math.round(Number(form.requestTimeoutSec) * 1000) }
        : {}),
      stream: form.stream,
      ...(form.verbosity ? { verbosity: form.verbosity } : {}),
      // Only persist features valid for the chosen model; drop the rest.
      features: Object.fromEntries(specialFeatures(form.family, form.model).map((s) => [s.key, !!form.features[s.key]])),
    };
    const r1 = await saveLLMProfile(input);
    if (!r1.ok) {
      setError(localizeServerError(r1.error, "save"));
      setSaving(false);
      return;
    }
    if (form.apiKey.trim() !== "") {
      const r2 = await setLLMKey(id, form.apiKey.trim());
      if (!r2.ok) {
        setError(localizeServerError(r2.error, "keySave"));
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    setForm(null);
    load();
  };

  const onSetActive = async (id: string) => { await setLLMActive(id); load(); };
  const onRoute = async (game: string, id: string) => { await setLLMRoute(game, id); load(); };
  const onDelete = async (id: string) => {
    const r = await deleteLLMProfile(id);
    if (!r.ok) setError(localizeServerError(r.error, "delete"));
    load();
  };
  const onClearKey = async (id: string) => {
    const r = await clearLLMKey(id);
    setConfirmClearId(null);
    setTestResult((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (!r.ok) setError(localizeServerError(r.error, "keySave"));
    load();
  };
  const onTest = async (id: string) => {
    setTesting(id);
    // Use the config's real agent slug (not a hardcoded "default") so Test works
    // for any agent. `||` (not `??`) so an empty stderr falls through to the
    // localized fallback instead of leaving a blank chip.
    const r = await runCli({ kind: "configTest", slug: view?.slug ?? "default", profileId: id });
    const j = r.json as { success?: boolean; latencyMs?: number; jsonValid?: boolean; error?: string } | undefined;
    const ok = j?.success === true;
    const msg = ok
      ? `${t("models.testOk")} · ${Math.round(j!.latencyMs ?? 0)}ms${j!.jsonValid ? " · JSON ✓" : ""}`
      : j?.error || r.error || r.stderr.trim() || t("models.testFail");
    setTestResult((prev) => ({ ...prev, [id]: { ok, msg } }));
    setTesting(null);
  };

  if (loading) return <Centered>{t("models.loading")}</Centered>;

  const profiles = view?.profiles ?? [];
  const configured = view?.configured ?? false;
  // E2 (windows-loop): config.json present but corrupt. R12 already stops
  // saveProfile overwriting it — but nothing SHOWED that, so the page looked like
  // a fresh install and walked the user through the whole add-a-model flow only
  // to refuse the save at the end. Warn, and offer no flow that cannot succeed.
  const configBroken = configPageState(view) === "broken";

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        eyebrow={t("eyebrow.models")}
        title={t("nav.models")}
        subtitle={t("models.intro")}
        right={
          <button onClick={load} title={t("models.refresh")} className="v3-dv-iconbtn">
            <RotateCw size={14} />
          </button>
        }
      />

      {error !== null && (
        <div className="v3-dv-banner v3-dv-err" data-tone="err">{error}</div>
      )}

      <ConfigBrokenBanner view={view} />

      {/* First-run: choose a PROTOCOL family */}
      {!configured && !configBroken && form === null && (
        <div className="v3-dv-card p-5">
          <div className="v3-dv-hd mb-2">{t("models.firstTitle")}</div>
          <div className="mb-3 text-[12px] text-[var(--text-muted)]">{t("models.firstHint")}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {FAMILIES.map((f) => (
              <button key={f.key} onClick={() => openAdd(f.key)} className="v3-dv-choice">
                {t(`models.fam.${f.key}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {form !== null && (
        <ProfileForm form={form} setForm={setForm} caps={caps} onSave={save} onCancel={() => { setForm(null); setError(null); }} saving={saving} t={t} />
      )}

      {configured && form === null && (
        <>
          <div className="flex items-center justify-between">
            <div className="text-[12px] text-[var(--text-muted)]">
              {t("models.active")}: <span className="font-mono text-[var(--text)]">{view?.activeProfile}</span>
            </div>
            <div className="relative">
              <select
                value=""
                onChange={(e) => { if (e.target.value) openAdd(e.target.value as ProtocolFamily); }}
                className="appearance-none rounded-md bg-[var(--accent)] px-2.5 py-1.5 pr-7 text-[12px] text-white"
              >
                <option value="">+ {t("models.addModel")}</option>
                {FAMILIES.map((f) => (
                  <option key={f.key} value={f.key}>{t(`models.fam.${f.key}`)}</option>
                ))}
              </select>
              <Plus size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-white" />
            </div>
          </div>

          <div className="space-y-2">
            {profiles.map((p) => (
              <div key={p.id} className="v3-dv-card px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-[var(--text)]">{p.displayName}</span>
                    {p.id === view?.activeProfile && (
                      <span className="v3-dv-chip" data-tone="ok">
                        <Star size={10} /> {t("models.activeBadge")}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[11px] text-[var(--text-faint)]">{t(`models.fam.${p.family}`)}</span>
                </div>

                <div className="mt-2 grid grid-cols-1 gap-1 text-[12px] sm:grid-cols-2">
                  <Field label={t("models.model")} value={p.model} />
                  <Field label={t("models.baseUrl")} value={p.baseURL ?? t("models.protocolDefault")} />
                  <Field label={t("models.adapter")} value={p.protocol} />
                  <Field label={t("models.maxTokensLabel")} value={String(p.maxTokens)} />
                  <Field label={t("models.requestTimeoutLabel")} value={String(Math.round((p.requestTimeoutMs ?? 270000) / 1000))} />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
                  <span className="flex items-center gap-1.5">
                    <KeyRound size={13} className="text-[var(--text-faint)]" />
                    {p.keyResolvable ? (
                      <span className="v3-dv-ok flex items-center gap-1"><Check size={12} /> {t("models.keyOk")}</span>
                    ) : (
                      <span className="v3-dv-warn flex items-center gap-1"><X size={12} /> {t("models.keyMissing")}</span>
                    )}
                  </span>
                  {p.thinkingEnabled && <span className="text-[var(--text-muted)]">{t("models.thinking")}{p.effort ? `: ${p.effort}` : ""}</span>}
                  {p.family === "openai_chat" && <span className="text-[var(--text-muted)]">{t("models.streaming")}: {p.stream}</span>}
                  {p.verbosity && <span className="text-[var(--text-muted)]">{t("models.verbosityLabel")}: {p.verbosity}</span>}
                  {p.features?.jsonObjectMode && <span className="v3-dv-chip">{t("models.featDeepseekJsonShort")}</span>}
                  {testResult[p.id] && (
                    <span className={testResult[p.id]!.ok ? "v3-dv-ok" : "v3-dv-err"}>· {testResult[p.id]!.msg}</span>
                  )}
                </div>

                {p.keyResolvable && p.keySource !== "" && (
                  <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--text-faint)]">
                    {t("models.keySource")}: {p.keySource}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {p.id !== view?.activeProfile && <SmallBtn onClick={() => onSetActive(p.id)}>{t("models.setActive")}</SmallBtn>}
                  <SmallBtn onClick={() => onTest(p.id)} accent><Zap size={12} /> {testing === p.id ? t("models.testing") : t("models.test")}</SmallBtn>
                  <SmallBtn onClick={() => openEdit(p)}>{t("models.edit")}</SmallBtn>
                  {p.keyResolvable &&
                    (confirmClearId === p.id ? (
                      <SmallBtn onClick={() => onClearKey(p.id)} danger><Trash2 size={12} /> {t("models.clearKeyConfirm")}</SmallBtn>
                    ) : (
                      <SmallBtn onClick={() => setConfirmClearId(p.id)}><KeyRound size={12} /> {t("models.clearKey")}</SmallBtn>
                    ))}
                  {profiles.length > 1 && <SmallBtn onClick={() => onDelete(p.id)} danger><Trash2 size={12} /> {t("models.delete")}</SmallBtn>}
                </div>
              </div>
            ))}
          </div>

          {profiles.length > 1 && (
            <div className="v3-dv-card px-5 py-4">
              <div className="v3-dv-hd mb-2">{t("models.routing")}</div>
              <RouteRow label={t("models.routeDefault")} value={view?.routing.default ?? ""} profiles={profiles} onChange={(id) => onRoute("default", id)} />
              {games.map((g) => (
                <RouteRow key={g} label={gameLabel(g)} value={view?.routing.byGame?.[g] ?? view?.routing.default ?? ""} profiles={profiles} onChange={(id) => onRoute(g, id)} />
              ))}
            </div>
          )}

          <p className="text-[12px] text-[var(--text-faint)]">{t("models.keyNote")}</p>
        </>
      )}
    </div>
  );
}

/**
 * Ask the capability registry (in main, over IPC) what this family+model supports.
 * Returns null until the first answer lands, and while the model field is empty.
 *
 * The model field is free-text and fires on every keystroke, so requests can resolve
 * out of order — an earlier one landing last would describe a prefix of what the user
 * typed. Only the newest sequence number may write back, the same discipline
 * maybeRaiseTokens uses for its recommendation.
 */
function useModelCapabilities(
  family: ProtocolFamily,
  model: string,
): ModelCapabilitiesResult | null {
  const [caps, setCaps] = useState<ModelCapabilitiesResult | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!model.trim()) {
      setCaps(null);
      return;
    }
    const mine = ++seq.current;
    void llmModelCapabilities({ family, model }).then((res) => {
      if (mine === seq.current) setCaps(res);
    });
  }, [family, model]);
  return caps;
}

function ProfileForm({ form, setForm, caps, onSave, onCancel, saving, t }: {
  form: FormState;
  setForm: (f: FormState) => void;
  caps: ModelCapabilitiesResult | null;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  t: (k: string) => string;
}) {
  const up = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const fdef = familyDef(form.family);
  const hint = detectHint(t, form.family, form.model, caps);
  const shape = reasoningShape(form.family, caps);
  const effortIssue = classifyEffort(form.effort, caps);
  const effortProblem = effortIssue === null ? null : {
    blocking: effortIssue.blocking,
    text: effortIssue.kind === "unstorable"
      ? `${t("models.effortUnstorable")} ${(caps?.storableEfforts ?? []).join(" · ")}`
      : t("models.effortWillClamp"),
  };
  const [tokenHint, setTokenHint] = useState<string | null>(null);
  // Live model discovery: the provider's own /models answer replaces the seeds.
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState<string | null>(null);
  // Only the LATEST recommendation request may write back. The recommend call is
  // async, and rapid model-field typing fires many — an earlier one resolving
  // last must not clobber newer input (or a newer model's maxTokens).
  const recSeq = useRef(0);
  // Always-fresh form, so the async recommend callback writes back onto LIVE
  // state (incl. the model the synchronous up() just set), never a stale closure.
  const formRef = useRef(form);
  formRef.current = form;

  // D4: when the user changes reasoning effort (or turns thinking on, or picks a
  // higher-ceiling model), a high effort can need up to the model's ceiling of
  // headroom. If the current maxTokens is below the recommendation, fill in the
  // recommended value (the user can still edit it) and show a hint. Only raises,
  // never lowers; only on an explicit change, so it never nags on open.
  const maybeRaiseTokens = (changed: Partial<Pick<FormState, "effort" | "thinkingEnabled" | "model" | "family">>) => {
    const next = { family: form.family, model: form.model, effort: form.effort, thinkingEnabled: form.thinkingEnabled, ...changed };
    const seq = ++recSeq.current;
    void llmRecommendMaxTokens({
      family: next.family,
      model: next.model,
      ...(next.effort ? { effort: next.effort } : {}),
      thinkingEnabled: next.thinkingEnabled,
    }).then((rec) => {
      if (seq !== recSeq.current) return; // superseded by a newer change — drop it
      const live = formRef.current;
      const cur = Number(live.maxTokens) || 0;
      if (rec && cur < rec.recommended) {
        // Spread LIVE form (has the model up() just set) and only fill maxTokens.
        setForm({ ...live, maxTokens: String(rec.recommended) });
        setTokenHint(`${next.effort || "high"} effort works best with max tokens ≥ ${rec.recommended}${rec.ceilingKnown ? " (this model's max)" : ""} — filled in for you; edit if you like.`);
      } else {
        setTokenHint(null);
      }
    });
  };
  return (
    <div className="v3-dv-card v3-dv-card--acc space-y-3 p-5">
      <div className="v3-dv-hd">{form.isNew ? t("models.addModel") : t("models.edit")}</div>

      <Row label={t("models.name")}>
        <input className={inputCls} value={form.displayName} onChange={(e) => up({ displayName: e.target.value })} placeholder={t("models.namePh")} />
      </Row>
      {form.isNew && (
        <Row label={t("models.id")}>
          <input className={inputCls} value={form.profileId} onChange={(e) => up({ profileId: e.target.value })} placeholder="claude / gpt / deepseek …" />
        </Row>
      )}
      <Row label={t("models.protocol")}>
        <select className={inputCls} value={form.family} onChange={(e) => { const family = e.target.value as ProtocolFamily; up({ family, effort: "high", budgetTokens: "", thinkingEnabled: family !== "openai_chat" }); }}>
          {FAMILIES.map((f) => (
            <option key={f.key} value={f.key}>{t(`models.fam.${f.key}`)}</option>
          ))}
        </select>
      </Row>
      <Row label={t("models.model")}>
        <div className="flex flex-wrap items-center gap-2">
          <input className={inputCls + " min-w-[220px] flex-1"} list="model-suggest" value={form.model} onChange={(e) => { up({ model: e.target.value }); maybeRaiseTokens({ model: e.target.value }); }} placeholder={fdef.models[0]} />
          {/* D3 (owner 2026-07-26): discovery is an EXPLICIT button — a network call
              with the user's key should happen when asked, not on every keystroke.
              The static seeds above are only the pre-key fallback. */}
          <button
            type="button"
            className="v3-dv-btn whitespace-nowrap"
            disabled={discovering}
            onClick={() => {
              setDiscovering(true);
              setDiscoverMsg(null);
              void llmDiscoverModels({
                family: form.family,
                model: form.model,
                baseURL: form.baseURL,
                ...(form.apiKey.trim() !== "" ? { apiKey: form.apiKey.trim() } : {}),
                ...(!form.isNew ? { profileId: form.profileId } : {}),
              }).then((res) => {
                setDiscovering(false);
                if (res === null || res.models.length === 0) {
                  setDiscoverMsg(t("models.discoverFail"));
                } else {
                  setDiscovered([...res.models]);
                  setDiscoverMsg(`${res.models.length} ${t("models.discoverOk")}`);
                }
              });
            }}
          >
            {discovering ? t("models.discoverBusy") : t("models.discoverBtn")}
          </button>
          <datalist id="model-suggest">{(discovered ?? fdef.models).map((m) => <option key={m} value={m} />)}</datalist>
        </div>
        {discoverMsg && <div className="mt-1 text-[11px] leading-snug text-[var(--text-faint)]">{discoverMsg}</div>}
      </Row>
      {hint && <div className="v3-dv-acc -mt-1 pl-0 text-[11px] sm:pl-[124px]">{t("models.detected")}: {hint}</div>}
      <Row label={t("models.baseUrl")}>
        <input className={inputCls} value={form.baseURL} onChange={(e) => up({ baseURL: e.target.value })} placeholder={t(fdef.baseURLPlaceholderKey)} />
      </Row>
      <Row label={t("models.apiKey")}>
        <input type="password" className={inputCls} value={form.apiKey} onChange={(e) => up({ apiKey: e.target.value })} placeholder={form.isNew ? t("models.apiKeyPh") : t("models.apiKeyKeep")} autoComplete="off" />
      </Row>
      {/* Reassurance at the exact moment the user pastes the secret — not buried at
          the form bottom — plus a nudge to verify the key with Test. */}
      <div className="-mt-1 pl-0 text-[11px] leading-snug text-[var(--text-faint)] sm:pl-[124px]">
        {t("models.keyReassure")} {t("models.testHint")}
      </div>

      {/* Captions sit ABOVE their input, not after it. They used to trail, so on a
          three-field row "temp" rendered between the temperature box and the
          maxTokens box and read as the label for the wrong one — an owner reported
          maxTokens as 270 (the request timeout) because of it. */}
      <Row label={t("models.sampling")}>
        <div className="flex flex-wrap items-end gap-3">
          <CapField label="temp">
            <input className={inputCls + " max-w-[110px]"} value={form.temperature} onChange={(e) => up({ temperature: e.target.value })} placeholder={t("models.temperaturePh")} />
          </CapField>
          <CapField label="maxTokens">
            <input className={inputCls + " max-w-[120px]"} value={form.maxTokens} onChange={(e) => { setTokenHint(null); up({ maxTokens: e.target.value }); }} placeholder="32000" />
          </CapField>
          <CapField label={t("models.requestTimeoutLabel")}>
            <input className={inputCls + " max-w-[110px]"} value={form.requestTimeoutSec} onChange={(e) => up({ requestTimeoutSec: e.target.value })} placeholder="270" />
          </CapField>
        </div>
        {tokenHint && <div className="v3-dv-acc mt-1 text-[11px] leading-snug">{tokenHint}</div>}
      </Row>

      {form.family === "openai_chat" && (
        <>
          <Row label={t("models.streaming")}>
            <select className={inputCls + " max-w-[200px]"} value={form.stream} onChange={(e) => up({ stream: e.target.value as FormState["stream"] })}>
              <option value="auto">{t("models.streamAuto")}</option>
              <option value="always">{t("models.streamAlways")}</option>
              <option value="never">{t("models.streamNever")}</option>
            </select>
          </Row>
          <div className="-mt-1 pl-0 text-[11px] leading-snug text-[var(--text-faint)] sm:pl-[124px]">{t("models.streamHint")}</div>
        </>
      )}

      <Row label={t("models.thinking")}>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[13px] text-[var(--text)]">
            <input type="checkbox" checked={form.thinkingEnabled} onChange={(e) => { const thinkingEnabled = e.target.checked; up({ thinkingEnabled }); maybeRaiseTokens({ thinkingEnabled }); }} disabled={caps?.thinkingAlwaysOn === true} />
            {t("models.thinkingOn")}
          </label>
        </div>
        {form.thinkingEnabled && shape === "tiers" && (
          <>
            {/* Owner decision 2026-07-26: tiers are CLICKABLE CHIPS, always visible,
                closed set — not a type-in combo whose options hide behind a caret.
                The registry only annotates: a tier the model doesn't list stays
                clickable and the note says what the adapter will send instead. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t("models.thinking")}>
              {tierChips(caps).map((tier) => {
                const selected = tier === "auto" ? form.effort === "" || form.effort === "auto" : form.effort === tier;
                const clamped = tier !== "auto" && classifyEffort(tier, caps)?.kind === "clamped";
                return (
                  <button
                    key={tier}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => { const effort = tier; up({ effort }); maybeRaiseTokens({ effort }); }}
                    className={
                      "rounded-full border px-2.5 py-0.5 text-[12px] transition-colors " +
                      (selected
                        ? "v3-dv-acc border-current font-medium"
                        : "border-[var(--line,#00000026)] text-[var(--text-muted)] hover:text-[var(--text)]") +
                      (clamped ? " border-dashed opacity-80" : "")
                    }
                  >
                    {tier === "auto" ? t("models.effortAuto") : tier}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-[var(--text-faint)]">
              {caps?.thinkingAlwaysOn === true && <div>{t("models.effortAlwaysOn")}</div>}
              {(form.effort === "" || form.effort === "auto") && (
                <div>{t("models.effortAutoHint")}{caps?.defaultEffort ? ` (${t("models.effortDefaultIs")} ${caps.defaultEffort})` : ""}</div>
              )}
              {caps !== null && caps.isKnownModel === false && <div>{t("models.effortFreeform")}</div>}
              {/* Selecting a chip the model doesn't list is allowed (D2) — but say
                  what will actually be sent BEFORE Save, not after. */}
              {effortProblem !== null && (
                <div className={effortProblem.blocking ? "text-[var(--danger,#c0392b)]" : "v3-dv-acc"}>{effortProblem.text}</div>
              )}
            </div>
          </>
        )}
        {form.thinkingEnabled && shape === "budget" && (
          <>
            {/* Budget-shaped models (Anthropic 4.5 generation, Gemini 2.5) take a
                token NUMBER, not a tier — the admin panel's budget_tokens control,
                derived from the registry instead of a hand-picked switch. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <input
                className={inputCls + " max-w-[130px]"}
                value={form.budgetTokens}
                onChange={(e) => up({ budgetTokens: e.target.value })}
                placeholder={t("models.budgetPh")}
                inputMode="numeric"
              />
              <span className="text-[11px] text-[var(--text-faint)]">{t("models.budgetUnit")}</span>
              {BUDGET_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => up({ budgetTokens: String(n) })}
                  className={
                    "rounded-full border px-2.5 py-0.5 text-[12px] " +
                    (form.budgetTokens === String(n)
                      ? "v3-dv-acc border-current font-medium"
                      : "border-[var(--line,#00000026)] text-[var(--text-muted)] hover:text-[var(--text)]")
                  }
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-[var(--text-faint)]">{t("models.budgetHint")}</div>
          </>
        )}
      </Row>

      {form.family === "openai_responses" && (
        <Row label={t("models.verbosityLabel")}>
          <select className={inputCls + " max-w-[160px]"} value={form.verbosity} onChange={(e) => up({ verbosity: e.target.value })}>
            <option value="">{t("models.verbosityDefault")}</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Row>
      )}

      {/* Model-specific special toggles (off by default; only shown when the model supports them). */}
      {specialFeatures(form.family, form.model).length > 0 && (
        <Row label={t("models.features")}>
          <div className="flex flex-col gap-1.5">
            {specialFeatures(form.family, form.model).map((s) => (
              <label key={s.key} className="flex items-center gap-1.5 text-[13px] text-[var(--text)]">
                <input
                  type="checkbox"
                  checked={Boolean(form.features[s.key])}
                  onChange={(e) => up({ features: { ...form.features, [s.key]: e.target.checked } })}
                />
                {t(s.labelKey)}
              </label>
            ))}
          </div>
        </Row>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <SmallBtn onClick={onCancel}>{t("models.cancel")}</SmallBtn>
        <button onClick={onSave} disabled={saving || form.model.trim() === "" || effortProblem?.blocking === true} className="v3-dv-btn v3-dv-btn--primary">
          {saving ? t("models.saving") : t("models.save")}
        </button>
      </div>
    </div>
  );
}

const inputCls = "v3-dv-input";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[120px_1fr] sm:items-center">
      <span className="text-[12px] text-[var(--text-muted)]">{label}</span>
      {/* One wrapper, always. Children used to be spread straight into the grid, so a
          row passing a field PLUS a hint line put the hint in the NEXT grid cell —
          the 120px label column — and it rendered as a 4-words-wide sliver. That is
          what happened to the maxTokens recommendation hint. min-w-0 lets the field
          shrink instead of forcing the column wider than the card. */}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** One captioned field inside a multi-field row. The caption is bound to its own
 *  input by being INSIDE the same label element and rendered above it, so it cannot
 *  be misread as belonging to the neighbouring field when the row wraps. */
function CapField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] leading-none text-[var(--text-faint)]">{label}</span>
      {children}
    </label>
  );
}

function RouteRow({ label, value, profiles, onChange }: { label: string; value: string; profiles: ConfigProfileView[]; onChange: (id: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5 text-[12px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <select className="v3-dv-input w-auto px-2 py-1 text-[12px]" value={value} onChange={(e) => onChange(e.target.value)}>
        {profiles.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
      </select>
    </div>
  );
}

function SmallBtn({ onClick, children, accent, danger }: { onClick: () => void; children: React.ReactNode; accent?: boolean; danger?: boolean }) {
  const variant = danger ? "v3-dv-btn--danger" : accent ? "v3-dv-btn--oline" : "v3-dv-btn--ghost";
  return (
    <button onClick={onClick} className={"v3-dv-btn v3-dv-btn--sm " + variant}>
      {children}
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[var(--text-faint)]">{label}:</span>
      <span className="truncate font-mono text-[var(--text)]">{value}</span>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center text-[13px] text-[var(--text-muted)]">{children}</div>
    </div>
  );
}
