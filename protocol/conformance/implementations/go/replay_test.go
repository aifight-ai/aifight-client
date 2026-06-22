package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// findSchemaRoot walks up from cwd until it hits protocol/schema.
func findSchemaRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	cur := wd
	for range 8 {
		candidate := filepath.Join(cur, "protocol", "schema")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	t.Fatal("could not find protocol/schema")
	return ""
}

// findTranscriptsRoot walks up to find protocol/transcripts.
func findTranscriptsRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	cur := wd
	for range 8 {
		candidate := filepath.Join(cur, "protocol", "transcripts")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	t.Fatal("could not find protocol/transcripts")
	return ""
}

func TestAllCommittedTranscriptsPass(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}

	root := findTranscriptsRoot(t)
	var files []string
	for _, sub := range []string{"happy_path", "edge_cases"} {
		dir := filepath.Join(root, sub)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && filepath.Ext(e.Name()) == ".jsonl" {
				files = append(files, filepath.Join(dir, e.Name()))
			}
		}
	}
	if len(files) == 0 {
		t.Fatal("no committed transcripts found")
	}

	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			r := ReplayReadMode(f, schemas)
			if r.Result != "PASS" {
				b, _ := json.MarshalIndent(r, "", "  ")
				t.Fatalf("expected PASS, got:\n%s", b)
			}
			if r.MessagesSeen == 0 {
				t.Fatal("expected at least one message")
			}
			if r.MessagesValidated != r.MessagesSeen {
				t.Fatalf("validated %d / seen %d", r.MessagesValidated, r.MessagesSeen)
			}
		})
	}
}

func TestDetectSchemaViolation(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}

	// Write a transcript whose only line is a game_start missing the
	// required `game` field. ReplayReadMode must FAIL with reason=schema.
	tmp := t.TempDir()
	bad := filepath.Join(tmp, "bad.jsonl")
	entry := map[string]interface{}{
		"timestamp_ms": 1,
		"direction":    "server_to_client",
		"actor":        "aaaaaaaa-0000-0000-0000-000000000001",
		"match_id":     "bbbbbbbb-0000-0000-0000-000000000001",
		"payload": map[string]interface{}{
			"type": "game_start",
			"data": map[string]interface{}{
				"match_id":       "bbbbbbbb-0000-0000-0000-000000000001",
				"rules":          map[string]interface{}{"name": "x", "summary": "x", "available_actions": map[string]string{}, "key_rules": []string{}},
				"config":         nil,
				"your_position":  0,
				"your_player_id": "p0",
				"players":        []interface{}{},
				// no "game" field
			},
		},
	}
	b, _ := json.Marshal(entry)
	if err := os.WriteFile(bad, append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}

	r := ReplayReadMode(bad, schemas)
	if r.Result != "FAIL" {
		t.Fatalf("expected FAIL; got PASS")
	}
	if r.FirstFailure == nil || r.FirstFailure.Reason != "schema" {
		t.Fatalf("expected reason=schema; got %+v", r.FirstFailure)
	}
	if !strings.Contains(r.FirstFailure.Detail, "game") {
		t.Fatalf("expected detail to mention missing 'game'; got %q", r.FirstFailure.Detail)
	}
}

func TestDetectMalformedJSONL(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}

	tmp := t.TempDir()
	bad := filepath.Join(tmp, "malformed.jsonl")
	if err := os.WriteFile(bad, []byte("{not json\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := ReplayReadMode(bad, schemas)
	if r.Result != "FAIL" {
		t.Fatal("expected FAIL on malformed JSONL")
	}
	if r.FirstFailure == nil || r.FirstFailure.Reason != "throw" {
		t.Fatalf("expected reason=throw; got %+v", r.FirstFailure)
	}
}

func TestMissingTranscriptFile(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	r := ReplayReadMode("/does/not/exist.jsonl", schemas)
	if r.Result != "FAIL" {
		t.Fatal("expected FAIL on missing file")
	}
	if r.FirstFailure == nil || r.FirstFailure.Reason != "throw" {
		t.Fatalf("expected reason=throw; got %+v", r.FirstFailure)
	}
}

// buildGameOverTranscript writes a single-line JSONL transcript whose
// only message is a game_over. Overrides let tests mutate individual
// fields (winner, payoffs, envelope match_id, forfeit_*, is_draw) to
// exercise the §5.1 assertions in isolation.
func buildGameOverTranscript(t *testing.T, override func(entry, data, result map[string]interface{})) string {
	t.Helper()
	entry := map[string]interface{}{
		"timestamp_ms": 1,
		"direction":    "server_to_client",
		"actor":        "aaaaaaaa-0000-0000-0000-000000000001",
		"match_id":     "bbbbbbbb-0000-0000-0000-000000000001",
	}
	result := map[string]interface{}{
		"payoffs": map[string]interface{}{
			"p0": float64(0),
			"p1": float64(10),
			"p2": float64(5),
		},
		"winner":  "p1",
		"is_draw": false,
	}
	data := map[string]interface{}{
		"match_id":   "cccccccc-0000-0000-0000-000000000001",
		"session_id": "bbbbbbbb-0000-0000-0000-000000000001",
		"result":     result,
		"replay_url": "/replay/x",
		"players": []interface{}{
			map[string]interface{}{
				"agent_id":   "aaaaaaaa-0000-0000-0000-000000000002",
				"agent_name": "Agent-1",
				"player_id":  "p0",
				"position":   0,
			},
			map[string]interface{}{
				"agent_id":   "aaaaaaaa-0000-0000-0000-000000000003",
				"agent_name": "Agent-2",
				"player_id":  "p1",
				"position":   1,
			},
			map[string]interface{}{
				"agent_id":   "aaaaaaaa-0000-0000-0000-000000000004",
				"agent_name": "Agent-3",
				"player_id":  "p2",
				"position":   2,
			},
		},
	}
	entry["payload"] = map[string]interface{}{
		"type": "game_over",
		"data": data,
	}
	if override != nil {
		override(entry, data, result)
	}
	tmp := t.TempDir()
	path := filepath.Join(tmp, "game_over.jsonl")
	b, _ := json.Marshal(entry)
	if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// Baseline: the synthetic game_over transcript PASSes as long as nothing
// is mutated. Guards against regression where a future assertion rejects
// the canonical shape.
func TestSyntheticGameOverBaselinePasses(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	path := buildGameOverTranscript(t, nil)
	r := ReplayReadMode(path, schemas)
	if r.Result != "PASS" {
		b, _ := json.MarshalIndent(r, "", "  ")
		t.Fatalf("baseline expected PASS; got:\n%s", b)
	}
	if r.EndedAtLine != 1 {
		t.Fatalf("expected ended_at_line=1; got %d", r.EndedAtLine)
	}
}

// §5.1: envelope entry.match_id must equal data.session_id on game_over.
// The real P1-1 bug in golden transcripts (bbbb-0002 vs bbbb-0001)
// is exactly this shape.
func TestDetectEnvelopeMatchIDMismatch(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	path := buildGameOverTranscript(t, func(entry, data, result map[string]interface{}) {
		entry["match_id"] = "bbbbbbbb-0000-0000-0000-000000000002"
	})
	r := ReplayReadMode(path, schemas)
	if r.Result != "FAIL" {
		t.Fatal("expected FAIL on envelope/session mismatch")
	}
	if r.FirstFailure == nil || r.FirstFailure.Reason != "assertion" ||
		!strings.Contains(r.FirstFailure.Detail, "entry.match_id") {
		t.Fatalf("expected assertion failure mentioning entry.match_id; got %+v", r.FirstFailure)
	}
}

// §5.1: winner (when set, !is_draw) must be the unique player with max payoff.
func TestDetectWinnerInconsistentWithPayoffs(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	path := buildGameOverTranscript(t, func(entry, data, result map[string]interface{}) {
		// winner says p0 but payoffs give max to p1.
		result["winner"] = "p0"
	})
	r := ReplayReadMode(path, schemas)
	if r.Result != "FAIL" {
		t.Fatal("expected FAIL on winner/payoff mismatch")
	}
	if r.FirstFailure == nil || r.FirstFailure.Reason != "assertion" ||
		!strings.Contains(r.FirstFailure.Detail, "winner") {
		t.Fatalf("expected assertion failure mentioning winner; got %+v", r.FirstFailure)
	}
}

// §5.1: a payoff tie (two players with the same max) plus a named
// winner is a contradiction — the spec requires is_draw=true or empty
// winner in that case.
func TestDetectWinnerTieWithNonEmptyWinner(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	path := buildGameOverTranscript(t, func(entry, data, result map[string]interface{}) {
		result["payoffs"] = map[string]interface{}{
			"p0": float64(10),
			"p1": float64(10),
			"p2": float64(0),
		}
		result["winner"] = "p0"
		result["is_draw"] = false
	})
	r := ReplayReadMode(path, schemas)
	if r.Result != "FAIL" {
		t.Fatal("expected FAIL on payoff tie with named winner")
	}
	if r.FirstFailure == nil || r.FirstFailure.Reason != "assertion" {
		t.Fatalf("expected assertion failure; got %+v", r.FirstFailure)
	}
}

// §5.1: when is_draw=true, winner agreement is not enforced. A draw
// with any winner string (or none) is accepted.
func TestDrawDoesNotEnforceWinnerMatch(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	path := buildGameOverTranscript(t, func(entry, data, result map[string]interface{}) {
		result["payoffs"] = map[string]interface{}{
			"p0": float64(5),
			"p1": float64(5),
			"p2": float64(0),
		}
		result["winner"] = ""
		result["is_draw"] = true
	})
	r := ReplayReadMode(path, schemas)
	if r.Result != "PASS" {
		b, _ := json.MarshalIndent(r, "", "  ")
		t.Fatalf("expected PASS on draw; got:\n%s", b)
	}
}

// §5.1: forfeit_reason and forfeited_by must co-occur (both set or both absent).
func TestDetectForfeitReasonMissingForfeitedBy(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	path := buildGameOverTranscript(t, func(entry, data, result map[string]interface{}) {
		data["forfeit_reason"] = "disconnect"
		// deliberately omit forfeited_by
	})
	r := ReplayReadMode(path, schemas)
	if r.Result != "FAIL" {
		t.Fatal("expected FAIL on forfeit reason without forfeited_by")
	}
	if r.FirstFailure == nil || r.FirstFailure.Reason != "assertion" ||
		!strings.Contains(r.FirstFailure.Detail, "forfeit") {
		t.Fatalf("expected assertion failure mentioning forfeit; got %+v", r.FirstFailure)
	}
}

// §5.1: matching forfeit_reason + forfeited_by pair is accepted even
// with no winner and is_draw=true (what the coup forfeit transcript looks like).
func TestForfeitPairIsAccepted(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	path := buildGameOverTranscript(t, func(entry, data, result map[string]interface{}) {
		data["forfeit_reason"] = "disconnect"
		data["forfeited_by"] = "p2"
		result["winner"] = ""
		result["is_draw"] = true
	})
	r := ReplayReadMode(path, schemas)
	if r.Result != "PASS" {
		b, _ := json.MarshalIndent(r, "", "  ")
		t.Fatalf("expected PASS on valid forfeit pair; got:\n%s", b)
	}
}

// §5: the terminal message (game_over, match_cancelled, terminal-error)
// MUST be the last message in the transcript. Anything after it is a
// protocol ordering violation that the conformance runner MUST flag.
func TestDetectMessagesAfterGameOver(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}

	// Build a 2-line transcript: valid game_over, then an unrelated welcome.
	goPath := buildGameOverTranscript(t, nil)
	goBytes, err := os.ReadFile(goPath)
	if err != nil {
		t.Fatal(err)
	}
	welcome := map[string]interface{}{
		"timestamp_ms": 2,
		"direction":    "server_to_client",
		"actor":        "aaaaaaaa-0000-0000-0000-000000000001",
		"payload": map[string]interface{}{
			"type": "welcome",
			"data": map[string]interface{}{
				"server_protocol_version": "v1.0.0",
				"agent_id":                "aaaaaaaa-0000-0000-0000-000000000001",
				"agent_name":              "Agent-1",
				"server_time":             "2026-04-24T00:00:00Z",
				"games":                   []string{"texas_holdem", "liars_dice", "coup"},
			},
		},
	}
	wBytes, _ := json.Marshal(welcome)
	bad := strings.TrimRight(string(goBytes), "\n") + "\n" + string(wBytes) + "\n"

	tmp := t.TempDir()
	badPath := filepath.Join(tmp, "after_game_over.jsonl")
	if err := os.WriteFile(badPath, []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	r := ReplayReadMode(badPath, schemas)
	if r.Result != "FAIL" {
		t.Fatalf("expected FAIL on message-after-game_over; got PASS")
	}
	if r.FirstFailure == nil || r.FirstFailure.Reason != "assertion" ||
		!strings.Contains(r.FirstFailure.Detail, "after terminal") {
		t.Fatalf("expected assertion failure 'after terminal'; got %+v", r.FirstFailure)
	}
	if r.FirstFailure.Line != 2 {
		t.Fatalf("expected failure to point at line 2 (the trailing welcome); got %d", r.FirstFailure.Line)
	}
}

// A terminal match_cancelled must also prevent later messages.
func TestDetectMessagesAfterMatchCancelled(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	tmp := t.TempDir()
	path := filepath.Join(tmp, "after_cancel.jsonl")
	cancelled := `{"timestamp_ms":1,"direction":"server_to_client","actor":"aaaaaaaa-0000-0000-0000-000000000001","payload":{"type":"match_cancelled","data":{"reason":"confirmation_timeout","action":"removed_from_queue"}}}` + "\n"
	welcome := `{"timestamp_ms":2,"direction":"server_to_client","actor":"aaaaaaaa-0000-0000-0000-000000000001","payload":{"type":"welcome","data":{"server_protocol_version":"v1.0.0","agent_id":"aaaaaaaa-0000-0000-0000-000000000001","agent_name":"Agent-1","server_time":"2026-04-24T00:00:00Z","games":["texas_holdem","liars_dice","coup"]}}}` + "\n"
	if err := os.WriteFile(path, []byte(cancelled+welcome), 0o644); err != nil {
		t.Fatal(err)
	}
	r := ReplayReadMode(path, schemas)
	if r.Result != "FAIL" {
		t.Fatal("expected FAIL on message-after-match_cancelled")
	}
	if r.FirstFailure == nil ||
		!strings.Contains(r.FirstFailure.Detail, "after terminal match_cancelled") {
		t.Fatalf("expected 'after terminal match_cancelled'; got %+v", r.FirstFailure)
	}
}

// Mid-match errors (error followed by retry action_request, as in the
// server_error_illegal_action edge transcript) must NOT be flagged as
// "messages after terminal". Error is terminal only when it is the
// last line.
func TestMidMatchErrorNotTerminal(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	// The committed server_error_illegal_action.jsonl already exercises
	// this: line 5 is error, line 6-7 are retry + action. Guard against
	// regression by re-running it explicitly here.
	r := ReplayReadMode(
		filepath.Join(findTranscriptsRoot(t), "edge_cases", "server_error_illegal_action.jsonl"),
		schemas,
	)
	if r.Result != "PASS" {
		b, _ := json.MarshalIndent(r, "", "  ")
		t.Fatalf("mid-match error transcript should PASS; got:\n%s", b)
	}
}

// EndedAtLine must surface in the Result for inspection (§5.1 invariant).
func TestEndedAtLineIsRecorded(t *testing.T) {
	schemas, err := LoadSchemas(findSchemaRoot(t))
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	r := ReplayReadMode(
		filepath.Join(findTranscriptsRoot(t), "edge_cases", "match_confirm_timeout.jsonl"),
		schemas,
	)
	// match_confirm_timeout's terminal is match_cancelled, not game_over —
	// so EndedAtLine should be 0 (unset).
	if r.Result != "PASS" {
		t.Fatalf("expected PASS; got %+v", r.FirstFailure)
	}
	if r.EndedAtLine != 0 {
		t.Fatalf("expected ended_at_line=0 for non-game_over terminal; got %d", r.EndedAtLine)
	}
}
