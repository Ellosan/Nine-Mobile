# AgentKey

A lightweight AI coding-agent client for Android. The **only** credential it asks for is an API
key plus the base URL of an OpenAI-compatible endpoint.

No server pairing. No QR codes. No Basic Auth layer in front of the model. No self-hosted
companion backend. You enter a base URL, an API key and a model name, and the app itself is the
agent.

Built for [9router](https://github.com/) style local routers (`http://<host>:20128/v1`), but it
works against anything that speaks `/v1/chat/completions` — OpenAI, vLLM, llama.cpp's server,
LiteLLM, Ollama's OpenAI shim, OpenRouter.

---

## What it does

- **Streaming chat** over SSE from `/v1/chat/completions`, rendered as Markdown with syntax-highlighted code blocks.
- **Multiple provider profiles** — switch between 9router at home, a VPS, and OpenAI without retyping anything.
- **Sessions** — create, rename, delete; stored in SQLite on the device.
- **An agentic tool-calling loop** — OpenAI-style function calling with `read_file`, `list_files`, `write_file` and `run_shell_command`. The app executes the tool, feeds the result back, and lets the model continue until it is done.
- **Per-call permission prompts** — `write_file` and `run_shell_command` block on an explicit tap every single time. There is no auto-allow, and no timeout that defaults to "yes".
- **API keys in the Android keystore** via `expo-secure-store` — never in the chat database, never in the Zustand store.

---

## Quick start

```bash
npm install
npx expo start
```

Then press `a` for an Android device/emulator, or scan the QR code with Expo Go.

> Expo Go is fine for chat and for trying the agent loop. Note that Expo Go does not carry this
> project's custom Android manifest changes, so **plain-`http://` endpoints and the Termux
> detection only work in a dev build or an EAS build** (see [Cleartext HTTP](#cleartext-http-important-for-9router)).

### First run

1. Open **Settings → Add provider**.
2. Fill in:
   - **Base URL** — e.g. `http://192.168.1.10:20128/v1`. The `/v1` suffix is added for you if you leave it off, and `http://` is assumed when you give no scheme.
   - **API key** — whatever your endpoint expects. 9router usually accepts any non-empty string.
   - **Model** — the exact id your endpoint serves.
3. Tap **Test connection**. This calls `GET /models` with those exact credentials and lists what came back, so you can tap a model name instead of typing it.
4. Tap **Save**, go back, and start a chat.

### Give the agent a folder (optional)

**Settings → Working directory → Choose folder.** The file tools do nothing until you do this.

---

## Building an APK with EAS

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform android --profile preview        # installable APK
```

`eas.json` ships four profiles:

| Profile | Output | Use for |
| --- | --- | --- |
| `development` | APK + dev client | Local development with native modules |
| `preview` | APK | Sideloading onto your own phone |
| `production` | AAB | Play Store |
| `production-apk` | APK | Sideloaded release build |

For a local build without EAS servers:

```bash
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

---

## Cleartext HTTP (important for 9router)

Android 9+ blocks plain `http://` by default. A LAN router like 9router is exactly that, so
without a manifest change every request fails with:

```
Cleartext HTTP traffic to 192.168.x.x not permitted
```

`plugins/withAgentKeyAndroid.js` is a local Expo config plugin that sets
`android:usesCleartextTraffic="true"` on the application element. It applies automatically during
`expo prebuild` and on every EAS build.

It also declares a `<queries>` block for `com.termux`, because under Android 11+ package
visibility an app cannot otherwise detect that Termux is installed.

Verify what it produces without doing a full build:

```bash
npx expo config --type introspect
```

---

## The agent loop

```
user message
   ↓
POST /v1/chat/completions  (stream: true, tools: [...])
   ↓
assistant streams text and/or tool_calls
   ↓
tool_calls?  ── no ──▶ done
   │ yes
   ▼
write_file / run_shell_command?  ── yes ──▶ BLOCK on the permission sheet
   │                                           │
   │  read_file / list_files                   ├─ deny  ─▶ tool result says DENIED
   ▼                                           └─ allow ─▶ execute
execute the tool
   ↓
append { role: "tool", tool_call_id, content } and loop
```

The loop stops when the model stops requesting tools, or after **Tool rounds per turn**
(Settings, default 12) — a safety valve against a model that loops forever.

`src/agent/loop.ts` has no React Native imports: the transport, the executor and the permission
gate are all injected. That is why the loop is covered by real tests (see [Tests](#tests)).

### Tools

| Tool | Approval | Notes |
| --- | --- | --- |
| `read_file` | none | UTF-8 text only, capped at 100 KB, binary files rejected |
| `list_files` | none | One directory at a time |
| `write_file` | **every call** | Creates parent directories as needed |
| `run_shell_command` | **every call** | See [Shell access](#shell-access) — disabled on a standard build |

---

## Sandboxing: what the file tools can and cannot touch

Android does not give apps arbitrary filesystem access, and **AgentKey does not try to get any**.
No root, no reflection tricks, no bundled busybox dropped into shared storage.

Instead you grant exactly one directory through the system's Storage Access Framework picker.
That folder is the entire world the file tools can see.

Every path the model supplies is normalised by `src/util/path.ts` before it reaches the
filesystem. Rejected outright:

- absolute paths — `/etc/passwd`
- traversal — `../outside`, `a/../../b`
- home-relative — `~/.ssh/id_rsa`
- Windows drive paths — `C:\x`
- URLs — `file:///etc/passwd`
- anything that resolves to the workspace root itself

This is covered by tests; see `path normalisation rejects everything that escapes the workspace`
in `tests/markdown.test.js`.

### A note on SAF filenames

The Storage Access Framework decides the final filename itself and may append an extension based
on the MIME type. AgentKey requests `application/octet-stream` for source files, which stops
Android turning `App.tsx` into `App.tsx.txt`. If the name still ends up different, the tool result
tells the model exactly what the file was actually called.

---

## Shell access

**On a standard Expo/EAS build, `run_shell_command` is disabled.** It is still advertised to the
model, but every call returns a clear `UNAVAILABLE:` message explaining why — which is deliberate,
because a model that knows the shell is gone will solve the task with the file tools instead of
retrying forever.

### Why

The only sanctioned way for one Android app to run a shell command in another is for that other
app to expose an entry point. Termux does: the `com.termux.RUN_COMMAND` intent.

The catch is that Termux receives it in `RunCommandService` — a **service**. Managed Expo only
exposes `IntentLauncher.startActivityAsync`, and you cannot start a service with it. So the
managed path genuinely cannot reach Termux, and bypassing the sandbox some other way is not on the
table.

### Enabling it

Shell execution needs a dev build carrying a small native module. `src/agent/termux.ts` already
looks for it on `NativeModules.AgentKeyTermux` and will use it the moment it exists:

```ts
interface AgentKeyTermuxModule {
  runCommand(
    command: string,
    args: string[],
    workdir: string | null
  ): Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
}
```

To build it:

1. **Install Termux** from [F-Droid](https://f-droid.org/packages/com.termux/) or GitHub releases — *not* the abandoned Play Store build, which is too old to have `RUN_COMMAND`.
2. **Allow external apps.** In `~/.termux/termux.properties` set `allow-external-apps = true`, then run `termux-reload-settings`.
3. **Declare the permission.** Already handled — `plugins/withAgentKeyAndroid.js` adds `com.termux.permission.RUN_COMMAND`.
4. **Write the native module.** Create an Expo module whose `runCommand` builds the `com.termux.RUN_COMMAND` intent (`com.termux/com.termux.app.RunCommandService`) with the `RUN_COMMAND_PATH`, `RUN_COMMAND_ARGUMENTS`, `RUN_COMMAND_WORKDIR` and `RUN_COMMAND_BACKGROUND` extras, dispatches it with `startForegroundService()`, and returns the result via a `PendingIntent`.
5. **Build with `expo prebuild` + `eas build`.** Expo Go cannot load custom native modules.

Until step 4 exists, the toggle in Settings is honest about what it does: it tells you the tool
will report itself unavailable.

---

## Project layout

```
app/                          expo-router screens
  _layout.tsx                 stack + store hydration
  index.tsx                   session list
  chat/[id].tsx               chat, composer, permission sheet
  settings/index.tsx          providers, working directory, tool switches
  settings/profile/[id].tsx   add/edit a provider, test connection

src/
  api/
    sse.ts                    spec-compliant SSE parser (no deps)
    openai.ts                 streaming client + delta accumulator + /models
  agent/
    toolSchemas.ts            tool definitions, system prompt
    loop.ts                   the agentic loop (RN-free, tested)
    executor.ts               tool call -> workspace action -> text result
    termux.ts                 shell bridge + availability reporting
  storage/
    secure.ts                 API keys (expo-secure-store)
    db.ts                     sessions, messages, profiles (expo-sqlite)
    workspace.ts              SAF-scoped working directory
  state/
    settingsStore.ts          profiles + agent settings (Zustand)
    chatStore.ts              transcript, streaming, permission gate
  ui/                         Markdown renderer, code blocks, bubbles, sheet
  util/
    path.ts                   path normalisation / traversal rejection
    markdown.ts               Markdown parser (no deps)
    highlight.ts              syntax highlighter (no deps)

plugins/withAgentKeyAndroid.js   cleartext HTTP + Termux queries + permission
tests/                           Node test suite (see below)
```

### Why the hand-rolled Markdown and highlighting

`react-native-markdown-display` drags in `markdown-it@10` and an image library, and the one
element that actually matters here — the fenced code block — is the one you most want control
over. The parser in `src/util/markdown.ts` and the highlighter in `src/util/highlight.ts` are a
few hundred lines between them, have zero dependencies, and cannot break when an upstream package
drops React Native support.

Neither uses regex lookbehind, since Hermes support for it is inconsistent across React Native
versions.

---

## Tests

The networking and agent layers are deliberately free of React Native imports, so they run under
plain Node against a real HTTP server — no mocking of `fetch`, no simulator required.

```bash
npm test
```

47 tests covering:

- **`tests/sse.test.js`** — SSE framing: CRLF, multi-line `data:`, comments, trailing events, and reassembly at *every* byte-boundary split.
- **`tests/stream.test.js`** — the streaming client against a mock OpenAI-compatible server that dribbles bytes out in 7-byte slices: text deltas, request shape, auth headers, tool-call arguments arriving in fragments, parallel tool calls, non-streaming fallback, `ApiError` on 401, mid-stream abort, `/models`, URL normalisation.
- **`tests/agentLoop.test.js`** — the full loop: tool results fed back on the next request, reads running without a prompt, writes blocking on approval, denials never reaching the executor, "allow for this turn", several tools in one assistant turn, executor failures reported rather than thrown, the iteration cap, API errors, and aborts.
- **`tests/markdown.test.js`** — Markdown parsing, highlighter round-tripping, and the path-traversal rejection table.

Type checking:

```bash
npm run typecheck     # tsc --noEmit
npx expo-doctor       # 21/21
```

---

## Configuration reference

| Setting | Where | Default |
| --- | --- | --- |
| Base URL / API key / model | Settings → provider | — |
| Temperature | Settings → provider | 0.7 |
| Max tokens | Settings → provider | server default |
| Working directory | Settings → Working directory | not set |
| File tools | Settings → Agent tools | on |
| Shell tool | Settings → Agent tools | off |
| Tool rounds per turn | Settings → Agent tools | 12 |
| System prompt | Settings → System prompt | see `DEFAULT_SYSTEM_PROMPT` |

---

## Troubleshooting

**"Cleartext HTTP traffic not permitted"** — you are on Expo Go. Use a dev build or an EAS build so
the config plugin applies. See [Cleartext HTTP](#cleartext-http-important-for-9router).

**"Network request failed"** — the phone and the router must be on the same network. Use the
machine's LAN IP, not `localhost` or `127.0.0.1`; on a phone those point at the phone.

**Replies arrive all at once instead of streaming** — some gateways ignore `stream: true`. The
client detects a plain JSON body and renders it as a single chunk rather than failing.

**"No working directory has been granted yet"** — Settings → Working directory → Choose folder.

**`run_shell_command` always returns UNAVAILABLE** — expected on a standard build. See
[Shell access](#shell-access).

**Model never calls tools** — check that File tools are on in Settings, that a working directory is
granted, and that the model you selected actually supports function calling.

---

## Not in v1

By design: no server pairing or remote OpenCode protocol, no voice input, no push notifications,
no multi-device sync, no iOS build.
