# MoreCode AI Gateway

This is a dedicated Morline service for MoreCode. It accepts Anthropic-compatible requests at
`POST /v1/messages`, keeps upstream credentials in service variables, and picks another upstream
only when the first one fails before a response body starts.

Required service variables:

- `GATEWAY_CLIENT_KEY`: the key saved in MoreCode Settings.
- `GATEWAY_UPSTREAMS`: JSON array of `{ id, url, key, models? }` entries. `url` is the upstream
  gateway base URL, for example `https://example.com/api/public/ai`.

Use `GET /health` with `X-API-Key: <GATEWAY_CLIENT_KEY>` to test the service.
