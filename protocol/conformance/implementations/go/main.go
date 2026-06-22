// Command replay-test-go is the Phase 0 Go reference implementation of
// the AIFight protocol conformance test — Mode A (replay-read) per
// replay-test-spec.md §2.
//
// Usage:
//
//	replay-test-go <transcript.jsonl> [--mode A] [--schema-root <path>]
//
// Exits 0 on PASS, 1 on FAIL, 2 on CLI/IO error. Stdout line 1 is the
// JSON result record (spec §3). Stderr carries diagnostics.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

// findRepoRoot walks up from the binary's directory (or working dir)
// until it finds a protocol/schema directory, and returns that path.
// Used so the CLI "just works" from protocol/conformance/implementations/go/
// during development.
func findRepoRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	cur := wd
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(cur, "protocol", "schema")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate, nil
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return "", fmt.Errorf("could not find protocol/schema from %s", wd)
}

func main() {
	mode := flag.String("mode", "A", "conformance mode: A (replay-read)")
	schemaRoot := flag.String("schema-root", "", "path to protocol/schema (auto-detected if empty)")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: %s <transcript.jsonl> [--mode A] [--schema-root <path>]\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

	args := flag.Args()
	if len(args) != 1 {
		flag.Usage()
		os.Exit(2)
	}
	transcriptPath := args[0]

	if *mode != "A" {
		fmt.Fprintf(os.Stderr, "mode %q not supported by the Go reference impl; only Mode A\n", *mode)
		os.Exit(2)
	}

	root := *schemaRoot
	if root == "" {
		r, err := findRepoRoot()
		if err != nil {
			fmt.Fprintf(os.Stderr, "--schema-root not given and auto-detection failed: %v\n", err)
			os.Exit(2)
		}
		root = r
	}

	schemas, err := LoadSchemas(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load schemas from %s: %v\n", root, err)
		os.Exit(2)
	}

	result := ReplayReadMode(transcriptPath, schemas)

	// Spec §3: single JSON result record on stdout.
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(result); err != nil {
		fmt.Fprintf(os.Stderr, "failed to write result record: %v\n", err)
		os.Exit(2)
	}

	if result.Result == "PASS" {
		os.Exit(0)
	}
	os.Exit(1)
}
