// Every string the bot says, in both languages it speaks.
//
// There is no i18n framework in the CLI and two languages do not justify
// adding one: this is a flat table of { zh, en } pairs plus a {placeholder}
// substitution. Adding a string means adding both halves — a missing
// translation is a type error, not a runtime surprise.

import type { NotifyEvent } from "../events";
import type { NotifyLocale } from "../locale";
import { escapeHtml, type TelegramInlineKeyboard } from "./api";

type Vars = Readonly<Record<string, string | number>>;

const STRINGS = {
  // ── Pairing / setup ────────────────────────────────────────────────
  pair_welcome: {
    zh: "✅ 已连接 AIFight\n\n这台机器上的 <b>{agent}</b> 现在会把战报和告警发到这里。\n发送 /menu 打开面板。",
    en: "✅ Connected to AIFight\n\n<b>{agent}</b> on this machine will send match results and alerts here.\nSend /menu to open the panel.",
  },
  test_message: {
    zh: "🔔 测试消息 — AIFight 通知已接通。\n代理:<b>{agent}</b>",
    en: "🔔 Test message — AIFight notifications are working.\nAgent: <b>{agent}</b>",
  },

  // ── Command menu (setMyCommands) ───────────────────────────────────
  cmd_menu: { zh: "主面板", en: "Main panel" },
  cmd_status: { zh: "状态速览", en: "Status at a glance" },
  cmd_daily: { zh: "查看/修改每日对局上限", en: "View or change the daily match cap" },
  cmd_challenge: { zh: "发起约战", en: "Create a challenge" },
  cmd_links: { zh: "常用链接", en: "Useful links" },
  cmd_mute: { zh: "静音通知", en: "Mute notifications" },
  cmd_help: { zh: "帮助", en: "Help" },

  // ── Match results ──────────────────────────────────────────────────
  result_win: { zh: "🏆 <b>胜利</b>（{label}）", en: "🏆 <b>Win</b> ({label})" },
  result_draw: { zh: "🤝 <b>平局</b>", en: "🤝 <b>Draw</b>" },
  result_forfeit: { zh: "🏳️ <b>判负</b>", en: "🏳️ <b>Forfeit</b>" },
  result_other: { zh: "🎲 <b>{label}</b>", en: "🎲 <b>{label}</b>" },
  result_line_meta: { zh: "{game} · {players} 人局", en: "{game} · {players} players" },
  // resultLabel() speaks English — it is the value the local session store keeps.
  // These say the same thing to a Chinese reader; unknown labels pass through.
  label_place: { zh: "第 {n} 名", en: "{n} place" },
  label_draw: { zh: "平局", en: "draw" },
  label_forfeit: { zh: "判负", en: "forfeit" },
  label_opponent_forfeit: { zh: "对手中途退出", en: "opponent forfeit" },
  label_completed: { zh: "已结束", en: "completed" },
  result_line_opponents: { zh: "对手：{names}", en: "Opponents: {names}" },
  result_line_forfeit_reason: { zh: "判负原因：{reason}", en: "Forfeit reason: {reason}" },
  button_replay: { zh: "🎬 看回放", en: "🎬 Watch replay" },

  // ── Alerts ─────────────────────────────────────────────────────────
  alert_header: { zh: "🚨 <b>需要你处理</b>", en: "🚨 <b>Needs your attention</b>" },
  // Two different failures, two different sentences — they used to share one,
  // which described neither.
  alert_llm_failure: {
    zh: "模型这一手没出成牌，桥用兜底动作替它出了。对局还在继续，但这种牌基本是送分,而且照样烧你的额度。\n对局：{match}\n原因：{reason}",
    en: "The model did not produce this turn's move, so the bridge played its own fallback. The match goes on, but a fallback move mostly gives away rating — and it still costs credits.\nMatch: {match}\nCause: {reason}",
  },
  alert_llm_no_action: {
    zh: "这一手<b>什么都没发出去</b>——本地决策整个失败了。回合会一直空转到超时,连续两次就判负。\n对局：{match}\n原因：{reason}",
    en: "<b>Nothing at all was sent</b> for this turn — the local decision failed outright. The turn now runs down its clock, and two of those forfeit the match.\nMatch: {match}\nCause: {reason}",
  },
  alert_disconnected: {
    zh: "桥已经掉线超过 {minutes} 分钟，还在自动重连中。这段时间里的对局会被判负。",
    en: "The bridge has been offline for over {minutes} minutes and is still retrying. Matches during an outage are forfeited.",
  },
  alert_recovered: {
    zh: "✅ 桥已恢复在线（这次离线约 {minutes} 分钟）。",
    en: "✅ The bridge is back online (it was offline for about {minutes} minutes).",
  },
  alert_forfeit: {
    zh: "这一局被判负（{reason}）。通常是代理没能在回合内出牌，或桥掉线了。",
    en: "That match was forfeited ({reason}). Usually the agent failed to answer in time, or the bridge dropped offline.",
  },
  alert_forfeit_no_reason: {
    zh: "这一局被判负。通常是代理没能在回合内出牌，或桥掉线了。",
    en: "That match was forfeited. Usually the agent failed to answer in time, or the bridge dropped offline.",
  },
  alert_fatal_device_mismatch: {
    zh: "这台机器的身份和该代理不符,已停止上场。需要在 Dashboard 重新配对（<code>aifight connect &lt;配对码&gt;</code>）。",
    en: "This machine's identity no longer matches the agent, so it stopped playing. Re-pair from the Dashboard (<code>aifight connect &lt;PAIRING_CODE&gt;</code>).",
  },
  alert_fatal_client_mismatch: {
    zh: "这个代理现在归另一个 AIFight 客户端（桌面 app 或另一台机器）所有,本机已停止上场。",
    en: "Another AIFight client (the desktop app, or another machine) now owns this agent, so this one stopped playing.",
  },
  alert_fatal_bridge_stopped: {
    zh: "桥已经放弃重连并停止运行,这台机器现在没有代理在场上。服务模式下会自动重启；如果之后一直收不到战报、bot 也不应答,就要上机器看看了。",
    en: "The bridge gave up reconnecting and stopped, so nothing is playing from this machine. A service install restarts it automatically; if it stays silent after that (no match reports, the bot does not answer), the machine needs a look.",
  },
  alert_fatal_credential_rejected: {
    zh: "AIFight 拒绝了本机的凭据,已停止上场。重新配对即可恢复。",
    en: "AIFight rejected this machine's credentials, so it stopped playing. Pairing again fixes it.",
  },

  // ── Daily digest ───────────────────────────────────────────────────
  digest_title: { zh: "📅 <b>今日战报</b> · {date}", en: "📅 <b>Today</b> · {date}" },
  // A bridge that was off for three days owes three days of report, and calling
  // that "today" is how the numbers start contradicting each other.
  digest_title_since: { zh: "📅 <b>战报</b> · {since} 以来", en: "📅 <b>Report</b> · since {since}" },
  digest_record: {
    zh: "{played} 局 · {wins} 胜 {losses} 负 {draws} 平",
    en: "{played} matches · {wins}W {losses}L {draws}D",
  },
  // Not every outcome is a win, a loss or a draw: an opponent quitting mid-match
  // is its own thing. Without this line the three numbers would quietly fail to
  // add up to the match count above them.
  digest_other: { zh: "其他 {count} 局（对手退出等）", en: "{count} other (opponent quit, etc.)" },
  digest_by_game: { zh: "{game}：{played} 局 {wins} 胜", en: "{game}: {played} played, {wins} won" },
  digest_rating: { zh: "评分变化：{deltas}", en: "Rating change: {deltas}" },
  digest_cost: { zh: "Token 成本：≈ {cost}", en: "Token cost: ≈ {cost}" },
  // NOT the same number as the line above and not the same window: the server
  // counts a rolling 24 h from its own reset mark, and only matches that count
  // against the daily cap (no friendlies, no manual one-shots). Saying "today"
  // next to the local tally invited the reader to spot a contradiction that was
  // never there.
  digest_server_games: {
    zh: "计入平台每日上限：{count} 局（平台口径,滚动 24 小时,不含手动局与友谊赛）",
    en: "Counted against the daily cap: {count} (platform's own rolling 24 h; excludes manual and friendly matches)",
  },
  digest_none: { zh: "今天没有对局。", en: "No matches today." },
  button_best_replay: { zh: "🎬 最佳一局", en: "🎬 Best match" },

  // ── Challenges ─────────────────────────────────────────────────────

  // ── Panels: buttons ────────────────────────────────────────────────
  btn_status: { zh: "📊 状态", en: "📊 Status" },
  btn_play: { zh: "🎮 对局", en: "🎮 Play" },
  btn_notify: { zh: "🔔 通知", en: "🔔 Alerts" },
  btn_settings: { zh: "⚙️ 设置", en: "⚙️ Settings" },
  btn_links: { zh: "🔗 链接", en: "🔗 Links" },
  btn_home: { zh: "« 主菜单", en: "« Menu" },
  btn_refresh: { zh: "🔄 刷新", en: "🔄 Refresh" },
  btn_pause: { zh: "⏸ 暂停自动匹配", en: "⏸ Pause auto-matching" },
  btn_resume: { zh: "▶️ 恢复自动匹配", en: "▶️ Resume auto-matching" },
  btn_confirm: { zh: "✅ 确定", en: "✅ Confirm" },
  btn_cancel: { zh: "✖️ 算了", en: "✖️ Cancel" },
  btn_custom: { zh: "自定义…", en: "Custom…" },
  btn_results_per_match: { zh: "每局", en: "Per match" },
  btn_results_daily: { zh: "每日摘要", en: "Daily" },
  btn_results_both: { zh: "两者", en: "Both" },
  btn_results_off: { zh: "关闭", en: "Off" },
  btn_mute_hour: { zh: "静音 1 小时", en: "Mute 1h" },
  btn_mute_today: { zh: "静音今天", en: "Mute today" },
  btn_unmute: { zh: "🔔 取消静音", en: "🔔 Unmute" },
  btn_alerts_on: { zh: "开启告警", en: "Alerts on" },
  btn_alerts_off: { zh: "关闭告警", en: "Alerts off" },
  btn_challenges_on: { zh: "开启约战通知", en: "Challenges on" },
  btn_challenges_off: { zh: "关闭约战通知", en: "Challenges off" },
  btn_duel: { zh: "⚔️ 约战", en: "⚔️ Challenge" },
  btn_rename: { zh: "✏️ 改名", en: "✏️ Rename" },
  btn_agent_page: { zh: "🪪 Agent 主页", en: "🪪 Agent page" },
  btn_dashboard: { zh: "📊 Dashboard", en: "📊 Dashboard" },
  btn_leaderboard: { zh: "🏆 排行榜", en: "🏆 Leaderboard" },
  btn_last_replay: { zh: "🎬 最近回放", en: "🎬 Last replay" },

  // ── Panels: body text ──────────────────────────────────────────────
  conn_online: { zh: "🟢 在线", en: "🟢 Online" },
  conn_offline: { zh: "🔴 离线（{state}）", en: "🔴 Offline ({state})" },
  conn_unknown: { zh: "⚪️ 状态未知", en: "⚪️ State unknown" },
  duration_minutes: { zh: "已连接 {minutes} 分钟", en: "connected {minutes}m" },
  duration_hours: { zh: "已连接 {hours} 小时 {minutes} 分", en: "connected {hours}h {minutes}m" },
  phase_idle: { zh: "当前：空闲", en: "Now: idle" },
  phase_matching: { zh: "当前：匹配中", en: "Now: matching" },
  phase_in_match: { zh: "当前：对局进行中", en: "Now: in a match" },
  status_phase: { zh: "{phase}", en: "{phase}" },
  status_today: { zh: "今日自动对局：{played} / {cap}", en: "Automatic matches today: {played} / {cap}" },
  status_cap_off: { zh: "关闭", en: "off" },
  status_unavailable: { zh: "平台状态暂不可用。", en: "Platform status is unavailable right now." },

  play_title: { zh: "对局", en: "Play" },
  play_state_running: { zh: "自动匹配：▶️ 运行中", en: "Auto-matching: ▶️ running" },
  play_state_paused: { zh: "自动匹配：⏸ 已暂停（重启桥后按配置恢复）", en: "Auto-matching: ⏸ paused (a bridge restart resumes it per your settings)" },
  play_state_manual: {
    zh: "自动匹配：⏹ 未开启（每日上限 0,只手动开局；去设置改上限）",
    en: "Auto-matching: ⏹ off (daily cap is 0 — manual only; raise it in Settings)",
  },
  play_manual_hint: {
    zh: "手动开一局不占每日上限,但会消耗你自己的模型额度。",
    en: "A manual match does not count against the daily cap, but it does spend your own model credits.",
  },
  play_started: { zh: "已排队：{game}。", en: "Queued: {game}." },
  play_paused: { zh: "已退出匹配队列。", en: "Left the matchmaking queue." },
  play_resumed: { zh: "已重新加入匹配队列。", en: "Back in the matchmaking queue." },

  notify_title: { zh: "通知", en: "Notifications" },
  notify_results: { zh: "战果推送：{value}", en: "Match results: {value}" },
  // The stored value is an enum (per_match | daily | both | off). It used to be
  // interpolated raw, so a Chinese reader saw "战果推送：per_match" — right next
  // to buttons that were translated.
  results_per_match: { zh: "每局都推", en: "every match" },
  results_daily: { zh: "只发每日摘要", en: "daily digest only" },
  results_both: { zh: "每局 + 每日摘要", en: "every match + daily digest" },
  results_off: { zh: "关闭", en: "off" },
  // Likewise for the connection state, which comes straight off the reconnect
  // state machine.
  conn_state_connecting: { zh: "连接中", en: "connecting" },
  conn_state_reconnecting: { zh: "重连中", en: "reconnecting" },
  conn_state_closed: { zh: "已关闭", en: "closed" },
  conn_state_idle: { zh: "未连接", en: "not connected" },
  notify_flags: { zh: "告警：{alerts} · 约战事件：{challenges}", en: "Alerts: {alerts} · Challenge events: {challenges}" },
  notify_muted_until: { zh: "🔇 已静音至 {time}（告警照常）", en: "🔇 Muted until {time} (alerts still arrive)" },
  // "Muted until 00:00" reads like it lapsed last night; "for the rest of today"
  // is the same instant said in a way nobody misreads.
  notify_muted_today: { zh: "🔇 今天剩下的时间都静音（告警照常）", en: "🔇 Muted for the rest of today (alerts still arrive)" },
  notify_not_muted: { zh: "🔔 未静音", en: "🔔 Not muted" },

  settings_title: { zh: "设置", en: "Settings" },
  settings_daily_current: { zh: "每日自动对局上限：{limit}", en: "Daily automatic match cap: {limit}" },
  settings_language: { zh: "语言：{language}", en: "Language: {language}" },
  settings_daily_set: { zh: "每日上限已设为 {limit}。", en: "Daily cap set to {limit}." },
  // The server clamps to the admin ceiling and answers with what it stored, so
  // this reports the number that is actually in force, not the one asked for.
  settings_daily_clamped: {
    zh: "平台把上限收到了 {limit}（你要的是 {asked}，超过了账号天花板）。",
    en: "AIFight capped it at {limit} (you asked for {asked}, which is above your account ceiling).",
  },
  settings_daily_note_start: {
    zh: "自动排队要等桥重启后才会开始。",
    en: "Automatic queueing starts after the bridge restarts.",
  },
  settings_daily_note_stop: {
    zh: "本次进程仍可能排在队里,桥重启后才彻底停止自动排队。",
    en: "This process may still be queued; automatic queueing fully stops after the bridge restarts.",
  },
  settings_daily_failed: { zh: "没能同步到 AIFight：{reason}", en: "Could not sync it to AIFight: {reason}" },
  // The change is live in the running bridge, but the disk write failed — the
  // panel must say so, or the new value on screen reads as "saved" while a
  // restart quietly reverts it.
  settings_unsaved: {
    zh: "⚠️ 本次已生效，但没能写入磁盘——桥重启后会回退。",
    en: "⚠️ Applied for this session, but it could not be written to disk — a bridge restart will revert it.",
  },
  settings_custom_prompt: {
    zh: "回复一个 0 到 {max} 之间的整数作为每日上限（0 = 只手动开局）。",
    en: "Reply with a whole number from 0 to {max} for the daily cap (0 = manual only).",
  },
  settings_custom_invalid: { zh: "请回复 0 到 {max} 之间的整数。", en: "Please reply with a whole number from 0 to {max}." },

  links_title: { zh: "常用链接", en: "Links" },

  duel_title: { zh: "约战", en: "Challenges" },
  duel_body: {
    zh: "选一个游戏生成约战链接,转发给朋友即可开战(友谊赛不计分,链接一次有效)。\n收到别人的链接?直接发给我就行。",
    en: "Pick a game to create a challenge link and forward it to a friend (friendly, unrated, one use).\nGot someone else's link? Just send it to me.",
  },
  challenge_share: {
    zh: "⚔️ <b>{game} 约战</b>\n{url}\n友谊赛不计分 · 链接一次有效",
    en: "⚔️ <b>{game} challenge</b>\n{url}\nFriendly, unrated · one use only",
  },
  challenge_accepted_ok: { zh: "已接受,对局马上开始。", en: "Accepted — the match starts now." },
  challenge_was_accepted: {
    zh: "⚔️ 你的 {game} 约战被 {guest} 接受了,对局开始。",
    en: "⚔️ {guest} accepted your {game} challenge — the match is starting.",
  },
  challenge_was_accepted_anon: {
    zh: "⚔️ 你的 {game} 约战被接受了,对局开始。",
    en: "⚔️ Your {game} challenge was accepted — the match is starting.",
  },
  settings_rename_prompt: {
    zh: "回复新的显示名(2-50 字符;它是公开标签,不是唯一用户名)。",
    en: "Reply with the new display name (2–50 characters; a public label, not a unique username).",
  },
  settings_rename_invalid: {
    zh: "名字要 {min} 到 {max} 个字符,再回复一个。",
    en: "The name has to be {min}–{max} characters — reply with another one.",
  },
  settings_renamed: {
    zh: "显示名已改为 {name}。CLI 控制命令（aifight start/stop）要等桥重启后才认新名字。",
    en: "Display name is now {name}. CLI control commands (aifight start/stop) pick up the new name after the bridge restarts.",
  },
  confirm_rename: { zh: "把显示名改成 <b>{name}</b>?", en: "Change the display name to <b>{name}</b>?" },
  confirm_create_challenge: { zh: "生成一个 {game} 约战链接?", en: "Create a {game} challenge link?" },
  confirm_accept_challenge: {
    zh: "这是一个约战链接,接受吗?接受后会立刻开局,消耗你的模型额度。",
    en: "That is a challenge link — accept it? The match starts at once and spends your model credits.",
  },
  action_failed: { zh: "没能完成:{reason}", en: "That did not go through: {reason}" },

  // ── Panels: confirmations & toasts ─────────────────────────────────
  confirm_start_match: {
    zh: "开一局 <b>{game}</b>?会真实调用你的模型,产生费用。",
    en: "Start a <b>{game}</b> match? It makes real model calls on your own key.",
  },
  confirm_pause: {
    zh: "暂停自动匹配?这只对当前进程有效,桥重启后按配置恢复。",
    en: "Pause automatic matching? This lasts until the bridge restarts, then your settings apply again.",
  },
  confirm_resume: { zh: "恢复自动匹配?", en: "Resume automatic matching?" },
  confirm_daily: { zh: "把每日自动对局上限改为 {limit}?", en: "Set the daily automatic match cap to {limit}?" },
  confirm_daily_high: {
    zh: "{limit} 局/天 远高于 {threshold},每局都会大量调用你的模型 — token 花销涨得很快。确定?",
    en: "{limit}/day is well above {threshold}. Every match makes many model calls on your key — costs add up fast. Sure?",
  },
  toast_expired: { zh: "这个按钮已失效,请重新操作。", en: "That button has expired — try again." },
  runner_busy: { zh: "正在对局中,稍后再试。", en: "Already in a match — try again when it finishes." },
  runner_unavailable: { zh: "桥当前没有连接,稍后再试。", en: "The bridge is not connected right now — try again shortly." },
  runner_failed: { zh: "没能执行：{reason}", en: "That did not go through: {reason}" },
  word_on: { zh: "开", en: "on" },
  word_off: { zh: "关", en: "off" },
  help_body: {
    zh: [
      "AIFight bot 能做的事:",
      "/menu 主面板 · /status 状态 · /daily 每日上限 · /links 常用链接 · /mute 静音",
      "",
      "它<b>不能</b>改你的模型配置、API key 或策略文件 —— 那些只在你自己的机器上改。",
    ].join("\n"),
    en: [
      "What this bot can do:",
      "/menu panel · /status status · /daily match cap · /links links · /mute quiet hours",
      "",
      "It <b>cannot</b> touch your model configuration, API keys, or strategy files — those stay on your machine.",
    ].join("\n"),
  },

  // ── Games ──────────────────────────────────────────────────────────
  game_texas_holdem: { zh: "德州扑克", en: "Texas Hold'em" },
  game_liars_dice: { zh: "骗子骰", en: "Liar's Dice" },
  game_coup: { zh: "政变", en: "Coup" },
  game_unknown: { zh: "对局", en: "Match" },
} as const satisfies Record<string, { readonly zh: string; readonly en: string }>;

export type MsgKey = keyof typeof STRINGS;

/** Look up one string and fill its {placeholders}. */
export function t(locale: NotifyLocale, key: MsgKey, vars: Vars = {}): string {
  const template = STRINGS[key][locale];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/** A game's display name, falling back to the raw id for anything new. */
export function gameName(locale: NotifyLocale, game: string | undefined): string {
  switch (game) {
    case "texas_holdem":
      return t(locale, "game_texas_holdem");
    case "liars_dice":
      return t(locale, "game_liars_dice");
    case "coup":
      return t(locale, "game_coup");
    case undefined:
      return t(locale, "game_unknown");
    default:
      return escapeHtml(game);
  }
}

export interface RenderedMessage {
  readonly text: string;
  readonly keyboard?: TelegramInlineKeyboard;
  /** Set when the message is better told with a picture (W5's OG card). */
  readonly photoUrl?: string;
}

/** One notification → one Telegram message. Pure: no I/O, no clock. */
export function renderNotifyEvent(
  locale: NotifyLocale,
  event: NotifyEvent,
  context: { readonly agentName: string },
): RenderedMessage {
  switch (event.kind) {
    case "match.result":
      return renderMatchResult(locale, event, context.agentName);
    case "alert.llm_failure":
      return alert(
        locale,
        t(locale, event.degraded === "no_action" ? "alert_llm_no_action" : "alert_llm_failure", {
          match: escapeHtml(event.matchId),
          reason: escapeHtml(event.reasonSummary),
        }),
      );
    case "alert.disconnected":
      return alert(locale, t(locale, "alert_disconnected", { minutes: Math.round(event.sinceMs / 60_000) }));
    case "alert.recovered":
      // Good news stands on its own without the 🚨 header; at least a minute,
      // so a same-second blip does not read as "0 minutes".
      return { text: t(locale, "alert_recovered", { minutes: Math.max(1, Math.round(event.offlineMs / 60_000)) }) };
    case "alert.forfeit":
      return alert(
        locale,
        event.reason === undefined
          ? t(locale, "alert_forfeit_no_reason")
          : t(locale, "alert_forfeit", { reason: escapeHtml(event.reason) }),
      );
    case "alert.fatal":
      return alert(locale, t(locale, `alert_fatal_${event.code}`));
    case "challenge.accepted":
      return {
        text: event.guestName === undefined
          ? t(locale, "challenge_was_accepted_anon", { game: gameName(locale, event.game) })
          : t(locale, "challenge_was_accepted", {
              game: gameName(locale, event.game),
              guest: escapeHtml(event.guestName),
            }),
      };
    case "digest.daily":
      return renderDailyDigest(locale, event);
  }
}

function renderMatchResult(
  locale: NotifyLocale,
  event: Extract<NotifyEvent, { kind: "match.result" }>,
  agentName: string,
): RenderedMessage {
  const label = escapeHtml(resultLabelText(locale, event.selfLabel));
  const headline = event.forfeitedSelf
    ? t(locale, "result_forfeit")
    : event.draw
      ? t(locale, "result_draw")
      : event.won
        ? t(locale, "result_win", { label })
        : t(locale, "result_other", { label });

  const lines = [
    `${headline} · ${t(locale, "result_line_meta", {
      game: gameName(locale, event.game),
      players: event.playerCount,
    })}`,
    escapeHtml(agentName),
  ];
  if (event.opponents.length > 0) {
    // 、 is the Chinese list comma; an English sentence takes ", ".
    lines.push(t(locale, "result_line_opponents", { names: escapeHtml(event.opponents.join(locale === "zh" ? "、" : ", ")) }));
  }
  if (event.forfeitedSelf && event.forfeitReason !== undefined) {
    lines.push(t(locale, "result_line_forfeit_reason", { reason: escapeHtml(event.forfeitReason) }));
  }

  const photoUrl = event.replayUrl === undefined ? undefined : ogCardUrl(event.replayUrl);
  return {
    text: lines.join("\n"),
    // A forfeited match has no published replay, so there is no button to show.
    ...(event.replayUrl !== undefined
      ? { keyboard: [[{ text: t(locale, "button_replay"), url: event.replayUrl }]] }
      : {}),
    ...(photoUrl !== undefined ? { photoUrl } : {}),
  };
}

/**
 * The share card AIFight already renders for a replay, reused as the picture on
 * the match report. When the personalised-card switch is off (or the replay is
 * private) the server 302s to the default image, so this degrades to a generic
 * card rather than a broken one.
 */
export function ogCardUrl(replayUrl: string): string | undefined {
  try {
    const url = new URL(replayUrl);
    const id = /\/replay\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
    if (id === undefined) return undefined;
    return `${url.origin}/og/replay/${id}.png`;
  } catch {
    return undefined;
  }
}

/** The stored `results` preference, in words rather than as its enum value. */
export function resultsPreferenceText(locale: NotifyLocale, value: string): string {
  switch (value) {
    case "per_match":
      return t(locale, "results_per_match");
    case "daily":
      return t(locale, "results_daily");
    case "both":
      return t(locale, "results_both");
    case "off":
      return t(locale, "results_off");
    default:
      return escapeHtml(value);
  }
}

/** The reconnect layer's state name, in words. */
export function connectionStateText(locale: NotifyLocale, state: string): string {
  switch (state) {
    case "connecting":
      return t(locale, "conn_state_connecting");
    case "reconnecting":
      return t(locale, "conn_state_reconnecting");
    case "closed":
      return t(locale, "conn_state_closed");
    case "idle":
      return t(locale, "conn_state_idle");
    default:
      return escapeHtml(state);
  }
}

/** Say a resultLabel() value in the reader's language. English is the source
 *  wording, so it passes straight through; anything unrecognised does too. */
function resultLabelText(locale: NotifyLocale, label: string): string {
  if (locale === "en") return label;
  const place = /^(\d+)(?:st|nd|rd|th) place$/.exec(label);
  if (place !== null) return t(locale, "label_place", { n: place[1]! });
  switch (label) {
    case "draw":
      return t(locale, "label_draw");
    case "forfeit":
      return t(locale, "label_forfeit");
    case "opponent forfeit":
      return t(locale, "label_opponent_forfeit");
    case "completed":
      return t(locale, "label_completed");
    default:
      return label;
  }
}

function renderDailyDigest(
  locale: NotifyLocale,
  event: Extract<NotifyEvent, { kind: "digest.daily" }>,
): RenderedMessage {
  const lines = [
    event.since === undefined
      ? t(locale, "digest_title", { date: escapeHtml(event.date) })
      : t(locale, "digest_title_since", { since: escapeHtml(event.since) }),
  ];
  if (event.played === 0) {
    lines.push(t(locale, "digest_none"));
  } else {
    const record = t(locale, "digest_record", {
      played: event.played,
      wins: event.wins,
      losses: event.losses,
      draws: event.draws,
    });
    const other = event.played - event.wins - event.losses - event.draws;
    lines.push(other > 0 ? `${record} · ${t(locale, "digest_other", { count: other })}` : record);
    for (const row of event.byGame) {
      lines.push(t(locale, "digest_by_game", {
        game: gameName(locale, row.game),
        played: row.played,
        wins: row.wins,
      }));
    }
  }
  if (event.ratingDeltas !== undefined && event.ratingDeltas.length > 0) {
    const deltas = event.ratingDeltas
      .map((d) => `${gameName(locale, d.game)} ${d.delta >= 0 ? "+" : ""}${Math.round(d.delta)}`)
      .join(" · ");
    lines.push(t(locale, "digest_rating", { deltas: escapeHtml(deltas) }));
  }
  // Only shown once the user has configured prices — an unpriced model would
  // otherwise imply a cost of zero.
  if (event.costText !== undefined) {
    lines.push(t(locale, "digest_cost", { cost: escapeHtml(event.costText) }));
  }
  if (event.gamesTodayServer !== undefined) {
    lines.push(t(locale, "digest_server_games", { count: event.gamesTodayServer }));
  }

  return {
    text: lines.join("\n"),
    ...(event.bestReplayUrl !== undefined
      ? { keyboard: [[{ text: t(locale, "button_best_replay"), url: event.bestReplayUrl }]] }
      : {}),
  };
}

function alert(locale: NotifyLocale, body: string): RenderedMessage {
  return { text: `${t(locale, "alert_header")}\n\n${body}` };
}

/** The `/commands` list registered with Telegram, in the bot's language. */
export function botCommands(locale: NotifyLocale): ReadonlyArray<{ command: string; description: string }> {
  return [
    { command: "menu", description: t(locale, "cmd_menu") },
    { command: "status", description: t(locale, "cmd_status") },
    { command: "daily", description: t(locale, "cmd_daily") },
    { command: "challenge", description: t(locale, "cmd_challenge") },
    { command: "links", description: t(locale, "cmd_links") },
    { command: "mute", description: t(locale, "cmd_mute") },
    { command: "help", description: t(locale, "cmd_help") },
  ];
}
