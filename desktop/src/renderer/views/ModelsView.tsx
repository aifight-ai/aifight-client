// D8 / D8.6 / D8.7 — Models: the GRAPHICAL, standalone LLM config editor,
// organized by the 4 API PROTOCOL FAMILIES (not by provider/model). A user
// installs the app and configures direct-LLM mode entirely here — pick a
// protocol, set model/endpoint, paste a key, tune temperature/maxTokens/
// streaming/reasoning, test — never touching the CLI.
//
// The per-model reasoning specifics (Opus 4.6 vs 4.7 vs 4.8; GPT-5.4 vs 5.5;
// DeepSeek V4; Gemini 3 vs 2.5) are auto-detected from the model id in the
// adapters — there's no manual variant switch. The UI just surfaces which effort
// levels a model supports and what will be sent, so the user can see it.
//
// Reads/writes the SAME agent config.json the CLI uses (config:* IPC); pasted
// keys → 0600 file in main. Fully bilingual (zh/en).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw, KeyRound, Check, X, Plus, Trash2, Zap, Star } from "lucide-react";

import {
  cliRun,
  getLLMConfig,
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
import type { ConfigProfileView, ConfigView, ProfileInput, ProtocolFamily } from "../../shared/ipc";


interface FamilyDef {
  key: ProtocolFamily;
  label: string;
  models: string[]; // current suggestions (datalist), editable
  baseURLPlaceholderKey: string;
}
// Model suggestions reflect current (2026) releases; the field stays free-text.
const FAMILIES: FamilyDef[] = [
  { key: "anthropic", label: "Anthropic (Messages)", models: ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-5"], baseURLPlaceholderKey: "models.baseUrlAnthropic" },
  { key: "openai_responses", label: "OpenAI Responses", models: ["gpt-5.5", "gpt-5.4"], baseURLPlaceholderKey: "models.baseUrlOpenai" },
  { key: "openai_chat", label: "OpenAI Chat 兼容 (DeepSeek / custom)", models: ["deepseek-v4-pro", "deepseek-v4-flash", "gpt-4o"], baseURLPlaceholderKey: "models.baseUrlChat" },
  { key: "gemini", label: "Gemini (generateContent)", models: ["gemini-3-pro", "gemini-3.5-flash", "gemini-2.5-pro", "gemini-2.5-flash"], baseURLPlaceholderKey: "models.baseUrlGemini" },
];
function familyDef(key: ProtocolFamily): FamilyDef {
  return FAMILIES.find((f) => f.key === key) ?? FAMILIES[0];
}

/**
 * Effort levels a model accepts. This is a non-authoritative UI mirror of the
 * canonical spec in runtime/src/llm/capabilities/model-capabilities.json (the
 * runtime adapters do the real normalization). Keep it consistent with that spec
 * and internal/llmcompat/compat.go (xhigh only on Opus 4.7/4.8; Sonnet 4.x and
 * Opus 4.6 top out at max).
 */
function effortOptionsFor(family: ProtocolFamily, model: string): string[] {
  const m = model.toLowerCase();
  if (family === "anthropic") {
    if (/opus-4[-.]?(7|8)/.test(m)) return ["low", "medium", "high", "xhigh", "max"];
    if (/opus-4[-.]?6|sonnet-4/.test(m)) return ["low", "medium", "high", "max"]; // adaptive, no xhigh
    return ["low", "medium", "high"]; // 4.5/3.7 legacy budget-based
  }
  if (family === "openai_responses") return ["low", "medium", "high", "xhigh"]; // gpt-5.x
  if (family === "openai_chat") return /deepseek/.test(m) ? ["high", "max"] : ["low", "medium", "high"];
  if (family === "gemini") return /gemini-3/.test(m) ? ["minimal", "low", "medium", "high"] : []; // 2.5 = budget
  return ["low", "medium", "high"];
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
function detectHint(t: (k: string) => string, family: ProtocolFamily, model: string): string {
  const m = model.toLowerCase();
  if (!model.trim()) return "";
  if (family === "anthropic") {
    if (/opus-4[-.]?(7|8)/.test(m)) return t("models.detAnthropicAdaptiveX");
    if (/opus-4[-.]?6|sonnet-4/.test(m)) return t("models.detAnthropicAdaptive");
    if (/4[-.]?5|3[-.]?7/.test(m)) return t("models.detAnthropicLegacy");
    return t("models.detAnthropicAdaptive");
  }
  if (family === "openai_responses") return t("models.detResponses");
  if (family === "openai_chat") return /deepseek/.test(m) ? t("models.detDeepseek") : t("models.detChat");
  if (family === "gemini") return /gemini-3/.test(m) ? t("models.detGemini3") : t("models.detGemini25");
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
  stream: "auto" | "always" | "never";
  thinkingEnabled: boolean;
  effort: string;
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
    stream: "auto",
    thinkingEnabled: true,
    effort: "",
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
      stream: p.stream,
      thinkingEnabled: p.thinkingEnabled,
      effort: p.effort ?? "",
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
      temperature: temp !== null && Number.isFinite(temp) ? temp : null,
      ...(form.maxTokens.trim() !== "" && Number(form.maxTokens) > 0 ? { maxTokens: Number(form.maxTokens) } : {}),
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
    const r = await cliRun(["config", "test", view?.slug ?? "default", "--profile", id, "--json"]);
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

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        eyebrow={t("eyebrow.models")}
        title={t("nav.models")}
        subtitle={t("models.intro")}
        right={
          <button
            onClick={load}
            title={t("models.refresh")}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
          >
            <RotateCw size={14} />
          </button>
        }
      />

      {error !== null && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">{error}</div>
      )}

      {/* First-run: choose a PROTOCOL family */}
      {!configured && form === null && (
        <div className="app-card p-5">
          <div className="mb-1 text-[14px] font-medium text-[var(--text)]">{t("models.firstTitle")}</div>
          <div className="mb-3 text-[12px] text-[var(--text-muted)]">{t("models.firstHint")}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {FAMILIES.map((f) => (
              <button key={f.key} onClick={() => openAdd(f.key)} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-left text-[13px] text-[var(--text)] transition-colors hover:border-[var(--accent)]/40">
                {t(`models.fam.${f.key}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {form !== null && (
        <ProfileForm form={form} setForm={setForm} onSave={save} onCancel={() => { setForm(null); setError(null); }} saving={saving} t={t} />
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
              <div key={p.id} className="app-card px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-[var(--text)]">{p.displayName}</span>
                    {p.id === view?.activeProfile && (
                      <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
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
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
                  <span className="flex items-center gap-1.5">
                    <KeyRound size={13} className="text-[var(--text-faint)]" />
                    {p.keyResolvable ? (
                      <span className="flex items-center gap-1 text-emerald-400"><Check size={12} /> {t("models.keyOk")}</span>
                    ) : (
                      <span className="flex items-center gap-1 text-amber-400"><X size={12} /> {t("models.keyMissing")}</span>
                    )}
                  </span>
                  {p.thinkingEnabled && <span className="text-[var(--text-muted)]">{t("models.thinking")}{p.effort ? `: ${p.effort}` : ""}</span>}
                  {p.family === "openai_chat" && <span className="text-[var(--text-muted)]">{t("models.streaming")}: {p.stream}</span>}
                  {p.verbosity && <span className="text-[var(--text-muted)]">{t("models.verbosityLabel")}: {p.verbosity}</span>}
                  {p.features?.jsonObjectMode && <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{t("models.featDeepseekJsonShort")}</span>}
                  {testResult[p.id] && (
                    <span className={testResult[p.id]!.ok ? "text-emerald-400" : "text-red-400"}>· {testResult[p.id]!.msg}</span>
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
            <div className="app-card px-5 py-4">
              <div className="mb-2 text-[13px] font-medium text-[var(--text)]">{t("models.routing")}</div>
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

function ProfileForm({ form, setForm, onSave, onCancel, saving, t }: {
  form: FormState;
  setForm: (f: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  t: (k: string) => string;
}) {
  const up = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const fdef = familyDef(form.family);
  const efforts = effortOptionsFor(form.family, form.model);
  const hint = detectHint(t, form.family, form.model);
  return (
    <div className="space-y-3 rounded-xl border border-[var(--accent)]/40 bg-[var(--surface)] p-5">
      <div className="text-[14px] font-medium text-[var(--text)]">{form.isNew ? t("models.addModel") : t("models.edit")}</div>

      <Row label={t("models.name")}>
        <input className={inputCls} value={form.displayName} onChange={(e) => up({ displayName: e.target.value })} placeholder={t("models.namePh")} />
      </Row>
      {form.isNew && (
        <Row label={t("models.id")}>
          <input className={inputCls} value={form.profileId} onChange={(e) => up({ profileId: e.target.value })} placeholder="claude / gpt / deepseek …" />
        </Row>
      )}
      <Row label={t("models.protocol")}>
        <select className={inputCls} value={form.family} onChange={(e) => up({ family: e.target.value as ProtocolFamily, effort: "" })}>
          {FAMILIES.map((f) => (
            <option key={f.key} value={f.key}>{t(`models.fam.${f.key}`)}</option>
          ))}
        </select>
      </Row>
      <Row label={t("models.model")}>
        <>
          <input className={inputCls} list="model-suggest" value={form.model} onChange={(e) => up({ model: e.target.value })} placeholder={fdef.models[0]} />
          <datalist id="model-suggest">{fdef.models.map((m) => <option key={m} value={m} />)}</datalist>
        </>
      </Row>
      {hint && <div className="-mt-1 pl-0 text-[11px] text-[var(--accent)] sm:pl-[124px]">{t("models.detected")}: {hint}</div>}
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

      <Row label={t("models.sampling")}>
        <div className="flex flex-wrap items-center gap-2">
          <input className={inputCls + " max-w-[110px]"} value={form.temperature} onChange={(e) => up({ temperature: e.target.value })} placeholder={t("models.temperaturePh")} />
          <span className="text-[11px] text-[var(--text-faint)]">temp</span>
          <input className={inputCls + " max-w-[120px]"} value={form.maxTokens} onChange={(e) => up({ maxTokens: e.target.value })} placeholder="16000" />
          <span className="text-[11px] text-[var(--text-faint)]">maxTokens</span>
        </div>
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
            <input type="checkbox" checked={form.thinkingEnabled} onChange={(e) => up({ thinkingEnabled: e.target.checked })} />
            {t("models.thinkingOn")}
          </label>
          {form.thinkingEnabled && efforts.length > 0 && (
            <select className={inputCls + " max-w-[160px]"} value={form.effort} onChange={(e) => up({ effort: e.target.value })}>
              <option value="">{t("models.effortDefault")}</option>
              {efforts.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
            </select>
          )}
        </div>
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
        <button onClick={onSave} disabled={saving || form.model.trim() === ""} className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] text-white transition-colors hover:opacity-90 disabled:opacity-50">
          {saving ? t("models.saving") : t("models.save")}
        </button>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]/50";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[120px_1fr] sm:items-center">
      <span className="text-[12px] text-[var(--text-muted)]">{label}</span>
      {children}
    </div>
  );
}

function RouteRow({ label, value, profiles, onChange }: { label: string; value: string; profiles: ConfigProfileView[]; onChange: (id: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5 text-[12px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <select className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[12px] text-[var(--text)] outline-none" value={value} onChange={(e) => onChange(e.target.value)}>
        {profiles.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
      </select>
    </div>
  );
}

function SmallBtn({ onClick, children, accent, danger }: { onClick: () => void; children: React.ReactNode; accent?: boolean; danger?: boolean }) {
  const cls = danger
    ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
    : accent
      ? "border-[var(--accent)]/40 text-[var(--accent)] hover:bg-[var(--accent)]/10"
      : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]";
  return (
    <button onClick={onClick} className={"flex items-center gap-1 rounded-md border bg-[var(--surface)] px-2.5 py-1.5 text-[12px] transition-colors " + cls}>
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
