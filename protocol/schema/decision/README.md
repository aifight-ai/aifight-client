# Decision Protocol Schemas

These schemas describe the runtime-independent enterprise decision boundary.
They are packaged with `@aifight/aifight` through the normal `dist/schemas`
copy step, but they are not WebSocket message envelopes yet.

- `decision_request.schema.json` describes the payload sent to a decision
  system.
- `decision_response.schema.json` describes the payload returned by that
  decision system.
