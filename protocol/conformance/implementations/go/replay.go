package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// TranscriptEntry mirrors the JSONL line shape documented in
// replay-test-spec.md §1. Fields that are sometimes absent are marked
// omitempty so round-tripping (which we don't do here) stays clean.
type TranscriptEntry struct {
	TimestampMs int64                  `json:"timestamp_ms"`
	Direction   string                 `json:"direction"`
	Actor       string                 `json:"actor"`
	MatchID     string                 `json:"match_id,omitempty"`
	Payload     map[string]interface{} `json:"payload"`
}

// Result is the JSON result record emitted on stdout (spec §3).
type Result struct {
	Transcript        string   `json:"transcript"`
	Implementation    string   `json:"implementation"`
	Mode              string   `json:"mode"`
	Result            string   `json:"result"` // "PASS" | "FAIL"
	MessagesSeen      int      `json:"messages_seen"`
	MessagesValidated int      `json:"messages_validated"`
	EndedAtLine       int      `json:"ended_at_line,omitempty"` // §5.1 — line of terminal game_over
	FirstFailure      *Failure `json:"first_failure"`
}

// Failure is emitted in the result record when something doesn't
// validate or terminal state is inconsistent.
type Failure struct {
	Line           int    `json:"line"`
	EntryDirection string `json:"entry_direction"`
	PayloadType    string `json:"payload_type"`
	Reason         string `json:"reason"` // "schema" | "assertion" | "throw"
	Detail         string `json:"detail"`
}

// FinalState is the post-replay invariant set per spec §5.
// Mode A asserts:
//   - Terminal classification (game_over | match_cancelled | error | "").
//   - If game_over: data.match_id (real UUID) and data.session_id must be set.
//   - If game_over: data.result.winner (if set and !is_draw) must equal the
//     player id with the unique maximum payoff.
//   - If game_over: envelope entry.match_id MUST equal data.session_id when
//     present (post-fix transcript routing invariant; see internal/hub/transcript.go).
//   - If game_over: forfeit_reason ↔ forfeited_by must co-occur (both set, or both absent).
//   - ended_at_line is set to the 1-based JSONL line of game_over.
//
// More checks (e.g. per-player rating deltas) can be layered on top.
type FinalState struct {
	TerminalType           string // "game_over" | "match_cancelled" | "error" | ""
	TerminalLine           int    // 1-based line number where the terminal was recorded
	EndedAtLine            int    // 1-based line number of the terminal game_over (alias of TerminalLine when terminal == game_over)
	MatchID                string // game_over.data.match_id (real uuid)
	SessionID              string // game_over.data.session_id
	EntryMatchIDAtGameOver string // envelope-level match_id on the game_over entry
	Winner                 string // game_over.data.result.winner
	IsDraw                 bool   // game_over.data.result.is_draw
	Payoffs                map[string]float64
	ForfeitReason          string
	ForfeitedBy            string
	SawSessionIDs          []string
}

// ReplayReadMode runs Mode A (replay-read) against a single transcript
// using the provided schema registry. Always returns a populated
// Result; never panics.
func ReplayReadMode(transcriptPath string, schemas *Schemas) Result {
	out := Result{
		Transcript:     transcriptPath,
		Implementation: "go-conformance-v0.1",
		Mode:           "A",
		Result:         "PASS",
	}

	f, err := os.Open(transcriptPath)
	if err != nil {
		out.Result = "FAIL"
		out.FirstFailure = &Failure{
			Line:   0,
			Reason: "throw",
			Detail: fmt.Sprintf("open transcript: %v", err),
		}
		return out
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 8*1024*1024)

	var state FinalState
	lineNo := 0
	sessionIDs := map[string]struct{}{}
	// Track the last payload type so a trailing `error` (with no
	// subsequent recovery) can be classified as a §5.3 terminal
	// post-loop. Inline classification would trip the "terminal must be
	// last" guard on legitimate mid-match errors (see
	// server_error_illegal_action.jsonl: error at line 5 followed by a
	// retry action_request at line 6).
	var lastPayloadType string
	var lastLineNo int

	for scanner.Scan() {
		lineNo++
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var entry TranscriptEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			out.Result = "FAIL"
			out.FirstFailure = &Failure{
				Line:   lineNo,
				Reason: "throw",
				Detail: fmt.Sprintf("malformed JSONL: %v", err),
			}
			out.MessagesSeen = lineNo
			return out
		}
		out.MessagesSeen++
		if entry.Payload == nil {
			out.Result = "FAIL"
			out.FirstFailure = &Failure{
				Line:           lineNo,
				EntryDirection: entry.Direction,
				Reason:         "schema",
				Detail:         "payload missing",
			}
			return out
		}
		payloadType, _ := entry.Payload["type"].(string)

		// Schema validation (spec §4).
		if err := schemas.ValidateMessage(entry.Payload); err != nil {
			out.Result = "FAIL"
			out.FirstFailure = &Failure{
				Line:           lineNo,
				EntryDirection: entry.Direction,
				PayloadType:    payloadType,
				Reason:         "schema",
				Detail:         err.Error(),
			}
			return out
		}
		out.MessagesValidated++
		lastPayloadType = payloadType
		lastLineNo = lineNo

		// Track session ids we've seen so session-stability can be asserted.
		// We do NOT pull in data.match_id for game_over (which is the real
		// match uuid, not a session id) — that would pollute the set.
		if data, ok := entry.Payload["data"].(map[string]interface{}); ok && payloadType != "game_over" {
			if sid, ok := data["match_id"].(string); ok && sid != "" {
				sessionIDs[sid] = struct{}{}
			}
		}
		if env, ok := entry.Payload["match_id"].(string); ok && env != "" && payloadType != "game_over" {
			sessionIDs[env] = struct{}{}
		}

		// Record terminal state if we see one.
		// Spec §5 "Final state" says the terminal message is the LAST
		// message. If we record a terminal here and subsequently read
		// another line, that's a protocol-level ordering violation.
		if state.TerminalType != "" {
			out.Result = "FAIL"
			out.FirstFailure = &Failure{
				Line:           lineNo,
				EntryDirection: entry.Direction,
				PayloadType:    payloadType,
				Reason:         "assertion",
				Detail: fmt.Sprintf(
					"messages after terminal %s at line %d",
					state.TerminalType, state.TerminalLine),
			}
			return out
		}
		switch payloadType {
		case "game_over":
			state.TerminalType = "game_over"
			state.TerminalLine = lineNo
			state.EndedAtLine = lineNo
			state.EntryMatchIDAtGameOver = entry.MatchID
			if data, ok := entry.Payload["data"].(map[string]interface{}); ok {
				if s, ok := data["match_id"].(string); ok {
					state.MatchID = s
				}
				if s, ok := data["session_id"].(string); ok {
					state.SessionID = s
				}
				if s, ok := data["forfeit_reason"].(string); ok {
					state.ForfeitReason = s
				}
				if s, ok := data["forfeited_by"].(string); ok {
					state.ForfeitedBy = s
				}
				if r, ok := data["result"].(map[string]interface{}); ok {
					if w, ok := r["winner"].(string); ok {
						state.Winner = w
					}
					if d, ok := r["is_draw"].(bool); ok {
						state.IsDraw = d
					}
					if p, ok := r["payoffs"].(map[string]interface{}); ok {
						state.Payoffs = make(map[string]float64, len(p))
						for pid, v := range p {
							if n, ok := v.(float64); ok {
								state.Payoffs[pid] = n
							}
						}
					}
				}
			}
		case "match_cancelled":
			state.TerminalType = "match_cancelled"
			state.TerminalLine = lineNo
		case "error":
			// error is only terminal if nothing else follows. We record
			// it tentatively and clear it if a later line arrives — but
			// the "no-messages-after-terminal" guard above rejects
			// anything after a game_over / match_cancelled. An error
			// followed by more messages is a non-terminal error (e.g.
			// the server_error_illegal_action edge case) and stays as
			// the non-terminal classification.
			//
			// Concretely: we only leave error as terminal if it is the
			// last line. To achieve that we don't set TerminalType here;
			// instead we post-pass the state after the loop finishes.
		}
	}
	if err := scanner.Err(); err != nil {
		out.Result = "FAIL"
		out.FirstFailure = &Failure{
			Line:   lineNo,
			Reason: "throw",
			Detail: fmt.Sprintf("scan: %v", err),
		}
		return out
	}

	// Post-loop: classify a trailing `error` (no subsequent recovery)
	// as a §5.3 terminal. Mid-match errors get filtered out here because
	// lastPayloadType would be something other than "error" (typically
	// action_request for the retry path).
	if state.TerminalType == "" && lastPayloadType == "error" {
		state.TerminalType = "error"
		state.TerminalLine = lastLineNo
	}

	for sid := range sessionIDs {
		state.SawSessionIDs = append(state.SawSessionIDs, sid)
	}
	sort.Strings(state.SawSessionIDs)

	// Spec §5.1 assertions — only when the terminal was game_over.
	if state.TerminalType == "game_over" {
		out.EndedAtLine = state.EndedAtLine

		if state.SessionID == "" {
			out.Result = "FAIL"
			out.FirstFailure = &Failure{
				Line:        state.EndedAtLine,
				PayloadType: "game_over",
				Reason:      "assertion",
				Detail:      "terminal game_over missing data.session_id",
			}
			return out
		}
		if state.MatchID == "" {
			out.Result = "FAIL"
			out.FirstFailure = &Failure{
				Line:        state.EndedAtLine,
				PayloadType: "game_over",
				Reason:      "assertion",
				Detail:      "terminal game_over missing data.match_id",
			}
			return out
		}

		// §5.1 envelope/session consistency — the server routes game_over
		// transcript entries by data.session_id (post-fix internal/hub/transcript.go);
		// the JSONL entry-level match_id, when present, must reflect that.
		if state.EntryMatchIDAtGameOver != "" && state.EntryMatchIDAtGameOver != state.SessionID {
			out.Result = "FAIL"
			out.FirstFailure = &Failure{
				Line:        state.EndedAtLine,
				PayloadType: "game_over",
				Reason:      "assertion",
				Detail: fmt.Sprintf(
					"entry.match_id %q != data.session_id %q on game_over",
					state.EntryMatchIDAtGameOver, state.SessionID),
			}
			return out
		}

		// §5.1 forfeit consistency — both set or both absent.
		if (state.ForfeitReason != "" && state.ForfeitedBy == "") ||
			(state.ForfeitedBy != "" && state.ForfeitReason == "") {
			out.Result = "FAIL"
			out.FirstFailure = &Failure{
				Line:        state.EndedAtLine,
				PayloadType: "game_over",
				Reason:      "assertion",
				Detail: fmt.Sprintf(
					"forfeit fields out of sync: reason=%q forfeited_by=%q",
					state.ForfeitReason, state.ForfeitedBy),
			}
			return out
		}

		// §5.1 winner ↔ payoffs agreement.
		// When is_draw=false and winner is set, winner must be the unique
		// player with the maximum payoff. A tie with a non-empty winner is
		// a contradiction. When winner is empty the transcript is opting
		// out of asserting a single winner (multi-winner games) — we do not
		// enforce further on that path.
		if state.Payoffs == nil {
			out.Result = "FAIL"
			out.FirstFailure = &Failure{
				Line:        state.EndedAtLine,
				PayloadType: "game_over",
				Reason:      "assertion",
				Detail:      "terminal game_over missing data.result.payoffs",
			}
			return out
		}
		if !state.IsDraw && state.Winner != "" {
			var maxPayoff float64
			var maxPlayers []string
			first := true
			for pid, p := range state.Payoffs {
				switch {
				case first:
					maxPayoff = p
					maxPlayers = []string{pid}
					first = false
				case p > maxPayoff:
					maxPayoff = p
					maxPlayers = []string{pid}
				case p == maxPayoff:
					maxPlayers = append(maxPlayers, pid)
				}
			}
			if len(maxPlayers) != 1 || maxPlayers[0] != state.Winner {
				sort.Strings(maxPlayers)
				out.Result = "FAIL"
				out.FirstFailure = &Failure{
					Line:        state.EndedAtLine,
					PayloadType: "game_over",
					Reason:      "assertion",
					Detail: fmt.Sprintf(
						"winner=%q inconsistent with payoffs max %v (max players: %v)",
						state.Winner, maxPayoff, maxPlayers),
				}
				return out
			}
		}
	}

	return out
}
