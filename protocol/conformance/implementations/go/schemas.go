package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

// Schemas is the compiled schema registry: every *.schema.json under
// protocol/schema/, plus a lookup from the wire-level message.type
// constant to the schema that validates that message's payload.
type Schemas struct {
	compiler *jsonschema.Compiler
	// messageTypeToID maps payload.type (e.g. "welcome") to the schema
	// $id to use with compiler.GetSchema.
	messageTypeToID map[string]string
	// compiled caches compiled schemas by $id.
	compiled map[string]*jsonschema.Schema
}

// LoadSchemas walks schemaRoot for *.schema.json, registers each with
// the compiler keyed on its absolute file path (which is how santhosh-
// tekuri/jsonschema references $refs across files), and builds the
// messageType→$id map by reading the `type` const in every
// messages/*.schema.json file.
func LoadSchemas(schemaRoot string) (*Schemas, error) {
	abs, err := filepath.Abs(schemaRoot)
	if err != nil {
		return nil, fmt.Errorf("abs path: %w", err)
	}

	c := jsonschema.NewCompiler()
	c.Draft = jsonschema.Draft7

	s := &Schemas{
		compiler:        c,
		messageTypeToID: make(map[string]string),
		compiled:        make(map[string]*jsonschema.Schema),
	}

	// Walk + add every schema to compiler.
	err = filepath.Walk(abs, func(p string, info os.FileInfo, werr error) error {
		if werr != nil {
			return werr
		}
		if info.IsDir() || !strings.HasSuffix(info.Name(), ".schema.json") {
			return nil
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return fmt.Errorf("read %s: %w", p, err)
		}
		var doc map[string]interface{}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return fmt.Errorf("parse %s: %w", p, err)
		}

		// Register with the compiler using the schema's $id. Relative
		// $refs like "../common/event.schema.json" in messages/server_*.schema.json
		// get re-expressed via each file's $id's base URL, so we also add
		// the file under its file:// path as a fallback resolver.
		id, _ := doc["$id"].(string)
		if err := c.AddResource(p, strings.NewReader(string(raw))); err != nil {
			return fmt.Errorf("add resource %s: %w", p, err)
		}
		if id != "" {
			if err := c.AddResource(id, strings.NewReader(string(raw))); err != nil {
				return fmt.Errorf("add resource (id) %s: %w", id, err)
			}
		}

		// Extract the payload.type const for messages/*.schema.json so we
		// know which schema to validate each entry against.
		rel, err := filepath.Rel(abs, p)
		if err == nil {
			parts := strings.Split(rel, string(filepath.Separator))
			if len(parts) > 0 && parts[0] == "messages" {
				if t, ok := extractTypeConst(doc); ok {
					// Prefer $id as the key so the compiler resolves refs via $id.
					// Fall back to file path if $id is missing (shouldn't happen
					// for committed schemas — lint would catch it).
					key := p
					if id != "" {
						key = id
					}
					s.messageTypeToID[t] = key
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Pre-compile every registered schema. If cross-file $refs are broken
	// we find out here, not at first validation.
	for typ, id := range s.messageTypeToID {
		sch, err := c.Compile(id)
		if err != nil {
			return nil, fmt.Errorf("compile %s (%s): %w", id, typ, err)
		}
		s.compiled[id] = sch
	}

	return s, nil
}

// extractTypeConst pulls the payload.type const string from a
// messages schema, which looks like:
//
//	"properties": { "type": { "const": "welcome" }, ... }
func extractTypeConst(doc map[string]interface{}) (string, bool) {
	props, ok := doc["properties"].(map[string]interface{})
	if !ok {
		return "", false
	}
	typeField, ok := props["type"].(map[string]interface{})
	if !ok {
		return "", false
	}
	c, ok := typeField["const"].(string)
	return c, ok
}

// ValidateMessage validates a payload object against the schema for
// its payload.type value. Returns nil on success, a diagnostic error
// on failure.
func (s *Schemas) ValidateMessage(payload map[string]interface{}) error {
	t, ok := payload["type"].(string)
	if !ok {
		return fmt.Errorf("payload.type missing or not a string")
	}
	id, ok := s.messageTypeToID[t]
	if !ok {
		return fmt.Errorf("no schema registered for message type %q", t)
	}
	sch, ok := s.compiled[id]
	if !ok {
		return fmt.Errorf("no compiled schema for %s", id)
	}
	if err := sch.Validate(payload); err != nil {
		return err
	}
	return nil
}
