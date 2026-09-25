# Relay REST API

Short reference for driving the relay board from another Node.js project running on the same machine.

- **Base URL:** `http://localhost:3000` (set with the `PORT` and `BIND` env vars; see [app.js](app.js))
- **Method:** every endpoint is `POST` with a JSON body (`Content-Type: application/json`).
- **Paths:** routes are mounted at the root, so use `/relay/set`, not `/api/relay/set`.
- **Response:** `{ "ok": true, ... }` on success. On failure you get HTTP `400` (or `404` for an unknown path) with `{ "ok": false, "error": "..." }`.
- **Connection:** you don't need to call `/relay/connect` first. Every relay command opens the TCP link to the board if it isn't already open.

## Channels

`channel` is an integer from `1` to `channels` (8 by default). To address every channel at once, pass `"all"`, `"a"`, `"*"`, or `9`.

`on` is the **physical** relay state. The per-channel `invert` flag is informational only and the server never applies it.

## Relay control

| Endpoint | Body | Effect |
|---|---|---|
| `/relay/set` | `{ "channel": 1, "on": true }` | Switch one channel, or all of them, on or off |
| `/relay/all` | `{ "on": false }` | Switch all channels |
| `/relay/pulse` | `{ "channel": 3, "ms": 500 }` | Turn on, wait `ms` (0–60000, default 500), then turn off. Responds after the pulse finishes. |
| `/relay/sequence` | `{ "actions": "on:1, wait:1000; off:1", "gap": 100 }` | Run steps in order (see below). Responds after the last step. |
| `/state` | `{}` | Read current state without changing anything |
| `/relay/connect` | `{ "host": "192.168.1.200", "port": 8800 }` | Connect explicitly. Both fields are optional and default to the saved settings. |
| `/relay/disconnect` | `{}` | Close the TCP link |

### Sequences

`actions` can be a string or an array.

- **String:** steps are separated by `;`. Each step is `on:<ch>` or `off:<ch>`, optionally followed by `, wait:<ms>`.
  `"on:1, wait:1000; on:2; on:all, wait:500; off:all"`
- **Array:** `[{ "channel": 1, "on": true, "wait": 1000 }, { "channel": "all", "on": false }]`

A step without its own `wait` uses `gap` (default 100 ms, max 10000). A step's `wait` can be 0–60000 ms.

### Channel settings

These are persisted to `data/settings.json`.

| Endpoint | Body |
|---|---|
| `/relay/name` | `{ "channel": 2, "name": "Pump" }` (max 40 characters; an empty string resets it) |
| `/relay/invert` | `{ "channel": 1, "invert": true }` |

## Response snapshot

Every successful response (and every `400` error from the API) includes the current app state:

```jsonc
{
  "ok": true,
  "message": "Channel 1 on",
  "settings": { "host": "192.168.1.200", "port": 8800, "channels": 8,
                "channelNames": ["MASTER", ...], "channelInvert": [true, ...], ... },
  "link":   { "host": "...", "port": 8800, "key": "192.168.1.200:8800",
              "connected": true, "lastReply": "", "lastError": null },
  "poll":   { "lastError": null, "lastOkAt": "...", "lastAttemptAt": "..." },
  "shadow": { "key": "192.168.1.200:8800", "updatedAt": "...",
              "channels": [ { "channel": 1, "state": true }, ... ] },  // state: true | false | null (unknown)
  "log":    [ ... ],
  "cursor": 42
}
```

Read relay states from `shadow.channels`. The response also contains the log entries newer than `since`. If you don't send `since`, the whole log buffer comes back, so send `{ "since": <last cursor> }` to keep responses small.

## Node.js client (Node 18+, built-in `fetch`)

```js
const BASE = process.env.RELAY_API || 'http://localhost:3000';

async function relayApi(path, body = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ since: Number.MAX_SAFE_INTEGER, ...body }) // skip log payload
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}

const relay = {
  set:      (channel, on)       => relayApi('/relay/set', { channel, on }),
  allOff:   ()                  => relayApi('/relay/all', { on: false }),
  pulse:    (channel, ms = 500) => relayApi('/relay/pulse', { channel, ms }),
  sequence: (actions, gap)      => relayApi('/relay/sequence', { actions, gap }),
  states:   async () => (await relayApi('/state')).shadow.channels
};

// usage
await relay.set(1, true);
await relay.pulse(3, 250);
await relay.sequence('on:1, wait:1000; off:1');
console.log(await relay.states()); // [{ channel: 1, state: false }, ...]
```

## curl

```sh
curl -s -X POST localhost:3000/relay/set -H 'Content-Type: application/json' -d '{"channel":1,"on":true}'
curl -s -X POST localhost:3000/state     -H 'Content-Type: application/json' -d '{}'
```

## Notes

- There is no authentication. By default the server binds to `0.0.0.0`; to restrict it to local clients, start it with `BIND=127.0.0.1`.
- `/relay/pulse` and `/relay/sequence` keep the HTTP request open until they finish, so set your client timeout above the total duration.
- `shadow` is the cached relay state. It updates after each command, and while the link is open it is also refreshed from the board every `pollInterval` ms (5 s by default). A `state` of `null` means the state is unknown. Check `poll.lastError` to see whether the cache is stale.
