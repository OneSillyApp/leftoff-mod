// Leftoff shared core (the mod, the daemon and the CLI all import it).
//
// Pure functions only: no Node.js APIs, no timers, no I/O. The Claude Code mod
// (hooks/register.js) and the local daemon (src/) both import this file, so the
// folder format, the status rules and the checkpoint prompt are defined once.
// A mod's hooks module may import files inside its own plugin directory by
// relative path, which is why this lives here and the daemon reaches in.

export const SCHEMA = 1
export const DEFAULT_PORT = 7429

export const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  dormantAfterMin: 15,
  minGapMin: 30,
  staleAfterSec: 180,
  longRunCheckpointMin: null,
  digest: { time: '07:00', lookbackHours: 24, topOfMind: true, days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], skipEmpty: true, timeZone: null },
  summarizer: { provider: 'auto', model: 'haiku', baseUrl: null, apiKeyEnv: null, maxInputChars: 24000 },
  machine: null,
  machineNames: {},
  redact: { patterns: ['(?i)api[_-]?key\\s*[:=]\\s*\\S+', 'sk-[A-Za-z0-9_-]{20,}'] },
  ignoreRepos: [],
  updates: { check: true, source: null }, // daily `git ls-remote` of the repo; never installs anything
  remoteHosts: [], // extra Host names the daemon answers (e.g. a Tailscale Serve name); see `leftoff tailscale`
  remoteRequireToken: true, // remote browsers sign in with a one-time link instead of getting the cookie on page load
  tabTitle: true, // the mod names the terminal tab after the session (through Claude Code's own /rename; see tabTitleFormat)
  tabTitleFormat: '{name}', // {name} = the session's title (or its repo), {repo}, {id} = 6-char id. Since 0.5.5 the "· cp:<id>" marker is added only when Go needs it (see formatTabTitle)
  liveCheckSec: 30, // how often the daemon checks that each session's Claude Code process is still running
  notify: { needsYou: true, delaySec: 10 }, // macOS notification when a session waits on a permission prompt or question (v0.4.4)
  remote: { allowAnswers: false }, // answering prompts from another device over Tailscale (off: only from this machine)
  summary: { length: 'informative' }, // checkpoint length: short | informative | long (v0.4.6; /cp --short / --long override once)
}

export const STATUSES = ['active', 'waiting', 'background', 'needs_input', 'dormant', 'ended', 'stale']
export const TRIGGERS = ['dormant', 'manual', 'session_end', 'clear', 'long_run', 'park']
export const EVENT_TYPES = [
  'session.opened', 'session.started', 'activity', 'turn_started', 'turn_completed',
  'notification', 'title_changed', 'heartbeat', 'session.ended',
  'session.parked', 'session.unparked', // 0.8.2: /cp-park and Park on the board
]
export const NEEDS_INPUT_NOTIFICATIONS = ['permission_prompt', 'elicitation_dialog', 'agent_needs_input']

// ---------------------------------------------------------------- small helpers

export function mergeConfig(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  if (!over || typeof over !== 'object') return out
  for (const k of Object.keys(over)) {
    const b = base ? base[k] : undefined
    const o = over[k]
    if (b && o && typeof b === 'object' && typeof o === 'object' && !Array.isArray(b) && !Array.isArray(o)) out[k] = mergeConfig(b, o)
    else out[k] = o
  }
  return out
}

// A time-ordered UUIDv7 (Codex rollouts, some Claude Code ids) starts with
// the clock: every session in the same few hours shared "01a133" (0.8.6).
// Those take their short forms from the random tail instead; UUIDv4 ids keep
// the head, so existing tab markers and folders still match.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function isTimeOrderedId(id) { return UUID_V7.test(String(id || '')) }
export function id8(id) {
  const s = String(id || '')
  if (isTimeOrderedId(s)) return s.replace(/-/g, '').slice(-8).toLowerCase()
  return s.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'unknown0'
}
// What id8 was before 0.8.6 (folders made then are still found by it).
export function legacyId8(id) {
  return String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'unknown0'
}

export function slugify(text, max = 40) {
  const s = String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (s.slice(0, max).replace(/-+$/g, '')) || 'untitled'
}

export function basename(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

export function repoName(session) {
  const r = session && session.repo
  if (r && r.name) return String(r.name).split('/').pop()
  if (r && r.root) return basename(r.root)
  return basename(session && session.cwd) || 'no-repo'
}

export function clip(text, n) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : s
}

export function toIso(t) {
  const d = t instanceof Date ? t : new Date(typeof t === 'number' ? t : Date.parse(t))
  if (isNaN(d.getTime())) return null
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function ms(t) {
  if (t == null || t === '') return NaN
  if (typeof t === 'number') return t
  return Date.parse(t)
}

// 2026-10-09T14:56:02Z -> 20261009T145602Z
export function compactStamp(iso) {
  return toIso(iso).replace(/[-:]/g, '')
}

// 2026-10-09T14:56:02Z -> 2026-10-09T145602Z (the checkpoint file name, no .md)
export function fileStamp(iso) {
  const s = toIso(iso)
  return s.slice(0, 10) + 'T' + s.slice(11, 19).replace(/:/g, '') + 'Z'
}

export function checkpointId(sessionId, createdAt, n = 0) {
  return 'cp_' + compactStamp(createdAt) + '_' + id8(sessionId) + (n ? '-' + (n + 1) : '')
}

export function checkpointFileName(createdAt, n = 0) {
  return fileStamp(createdAt) + (n ? '-' + (n + 1) : '') + '.md'
}

// {start-date}_{repo}_{slug of first title}_{first 8 chars of id}
export function sessionFolderName(session) {
  const date = (toIso(session.startedAt || Date.now()) || '').slice(0, 10)
  return [date, slugify(repoName(session), 24), slugify(session.title, 40), id8(session.id)].join('_')
}

// Multi-machine: every record carries the machine it was made on, and each
// machine writes only under its own subfolder (sessions/<machine>/,
// digests/<machine>/, .spool/<machine>/), so two machines syncing one folder
// never write the same file.
export function machineSlug(name) {
  return slugify(String(name || '').replace(/\.local$/i, ''), 40) || 'unknown'
}

// env override > config machineNames[hostname] > config machine > hostname
export function resolveMachine({ env, hostname, cfg = {} } = {}) {
  if (env) return machineSlug(env)
  const names = cfg.machineNames || {}
  if (hostname && names[hostname]) return machineSlug(names[hostname])
  if (cfg.machine) return machineSlug(cfg.machine)
  return machineSlug(hostname || 'unknown')
}

export function camelToSnake(k) { return k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()) }
export function snakeToCamel(k) { return k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()) }

function mapKeys(obj, fn, deep) {
  if (Array.isArray(obj)) return obj.map((v) => (deep ? mapKeys(v, fn, deep) : v))
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[fn(k)] = deep && v && typeof v === 'object' ? mapKeys(v, fn, deep) : v
  return out
}
export const toSnake = (o) => mapKeys(o, camelToSnake, true)
export const toCamel = (o) => mapKeys(o, snakeToCamel, true)

// ---------------------------------------------------------------- frontmatter
// A small YAML subset: `key: value` lines; values are null, booleans, numbers,
// plain or double/single-quoted strings, flow sequences [a, b], flow maps
// {k: v}, and block sequences ("- item" lines) for hand edits. Enough for what
// we write and for what a person typing in a markdown app is likely to change.

const RESERVED = /^(null|~|true|false|yes|no|on|off|y|n)$/i
const NUMBERISH = /^[-+]?(\d[\d_]*)?(\.\d+)?([eE][-+]?\d+)?$/

function needsQuotes(s) {
  if (s === '') return true
  if (RESERVED.test(s)) return true
  if (NUMBERISH.test(s) && /\d/.test(s)) return true
  if (/^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true
  if (/\s$/.test(s)) return true
  if (/:(\s|$)|\s#|[,\[\]{}\n\r\t"]/.test(s)) return true
  return false
}

export function fmScalar(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return Number.isFinite(v) || typeof v === 'boolean' ? String(v) : 'null'
  if (Array.isArray(v)) return '[' + v.map(fmScalar).join(', ') + ']'
  if (typeof v === 'object') {
    const parts = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => k + ': ' + fmScalar(x))
    return '{' + parts.join(', ') + '}'
  }
  const s = String(v)
  return needsQuotes(s) ? JSON.stringify(s) : s
}

export function toFrontmatter(obj, order = []) {
  const keys = [...order.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !order.includes(k))]
  const lines = ['---']
  for (const k of keys) {
    if (obj[k] === undefined) continue
    lines.push(k + ': ' + fmScalar(obj[k]))
  }
  lines.push('---')
  return lines.join('\n') + '\n'
}

function splitFlow(inner) {
  const out = []
  let depth = 0, quote = null, cur = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"') { cur += inner[++i] || ''; continue }
      if (c === quote) {
        if (quote === "'" && inner[i + 1] === "'") { cur += inner[++i]; continue }
        quote = null
      }
      continue
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '[' || c === '{') depth++
    if (c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim() !== '') out.push(cur.trim())
  return out
}

function stripComment(s) {
  // a ' #' outside quotes starts a comment
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd()
  }
  return s
}

export function parseScalar(raw) {
  const s = stripComment(String(raw).trim())
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if (/^(true|True|TRUE)$/.test(s)) return true
  if (/^(false|False|FALSE)$/.test(s)) return false
  if (s[0] === '"') { try { return JSON.parse(s) } catch { return s.slice(1, -1) } }
  if (s[0] === "'") return s.slice(1, s.endsWith("'") ? -1 : undefined).replace(/''/g, "'")
  if (s[0] === '[') return splitFlow(s.slice(1, s.lastIndexOf(']'))).map(parseScalar)
  if (s[0] === '{') {
    const o = {}
    for (const part of splitFlow(s.slice(1, s.lastIndexOf('}')))) {
      const m = part.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:]+?)\s*:\s*(.*)$/)
      if (!m) continue
      o[String(parseScalar(m[1]))] = parseScalar(m[2])
    }
    return o
  }
  if (NUMBERISH.test(s) && /\d/.test(s)) { const n = Number(s.replace(/_/g, '')); if (!isNaN(n)) return n }
  return s
}

export function parseFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!src.startsWith('---\n') && src !== '---') return { data: {}, body: src }
  const end = src.indexOf('\n---', 4)
  if (end < 0) return { data: {}, body: src }
  const head = src.slice(4, end)
  let body = src.slice(end + 4)
  body = body.replace(/^[^\n]*\n?/, '') // rest of the closing '---' line
  const data = {}
  const lines = head.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s?(.*)$/)
    if (!m) continue
    const [, key, rest] = m
    if (rest.trim() === '') {
      const items = []
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) { items.push(parseScalar(lines[++i].replace(/^\s+-\s+/, ''))); }
      data[key] = items.length ? items : null
    } else {
      data[key] = parseScalar(rest)
    }
  }
  return { data, body }
}

// ---------------------------------------------------------------- checkpoint markdown

const CP_ORDER = ['id', 'session_id', 'session_title', 'created_at', 'trigger', 'machine', 'repo', 'branch', 'cwd',
  'files_touched', 'turns_since_last', 'user_note', 'open_question', 'parse_ok', 'format', 'length', 'generator', 'schema']

export function resumeCommand(session) {
  const id = session.id || session.sessionId
  const cwd = resumeDir(session)
  const wt = resumeWorktreeName(session)
  const args = [...(wt ? ['--worktree', wt] : []), '--resume', id, ...addDirFlags(session)]
  return (cwd ? 'cd ' + shArg(cwd) + ' && ' : '') + (isCodex(session) ? codexInvocation(id) : wasLiveSession(session) ? liveInvocation(args) : claudeInvocation(session, args))
}

// 0.9.8: a session started with `leftoff live` (it had Leftoff's Live channel)
// resumes as one, `leftoff live -- --resume <id>`, so it shows up Live again.
// Codex and Ollama sessions resume their own way (Live is Claude Code only).
export function wasLiveSession(session) {
  if (!session || isCodex(session) || (session.backend && session.backend.kind === 'ollama')) return false
  return !!(session.wasLive || (session.liveLink && session.liveLink.on))
}
// 0.9.8: the same resume, but as Live (Leftoff's channel), for a Claude Code
// session that wasn't Live: exit it, then run this. null when it already resumes
// Live, or can't be Live (Codex, Ollama).
export function liveResumeCommand(session) {
  if (!session || isCodex(session) || (session.backend && session.backend.kind === 'ollama') || wasLiveSession(session)) return null
  const id = session.id || session.sessionId
  const cwd = resumeDir(session)
  const wt = resumeWorktreeName(session)
  return (cwd ? 'cd ' + shArg(cwd) + ' && ' : '') + liveInvocation([...(wt ? ['--worktree', wt] : []), '--resume', id, ...addDirFlags(session)])
}
// 0.9.12: a session started from a project had its other repos as --add-dir;
// resuming it in a terminal gets them back (Claude Code doesn't keep them).
export function addDirFlags(session) {
  const dirs = session && session.startProject && Array.isArray(session.startProject.addDirs) ? session.startProject.addDirs : []
  return dirs.filter((d) => typeof d === 'string' && d.startsWith('/') && !d.includes('\0')).slice(0, 8).flatMap((d) => ['--add-dir', d])
}
export function liveInvocation(args = []) { return 'leftoff live --' + (args.length ? ' ' + args.map(shArg).join(' ') : '') }

// 0.8.0: a Codex session (its rollout under ~/.codex/sessions) resumes with `codex resume <id>`.
export function isCodex(session) { return !!session && session.codingAgent === 'codex' }
export function codexInvocation(id) { return 'codex resume ' + shArg(id) }

// 0.7.1: where to run `claude --resume`: the session's folder, or, inside a git
// worktree, that worktree's own top folder (Claude Code declines to re-enter a
// `git worktree add` worktree from one of its subfolders; code.claude.com/docs/en/worktrees).
//
// 0.8.8: a worktree Claude Code made (<repo>/.claude/worktrees/<name>, from
// `claude --worktree` or EnterWorktree) is resumed the way Claude Code itself
// prints on exit: from the main checkout, `claude --worktree <name> --resume <id>`.
// On exit Claude Code moves the session back to where it was launched and
// clears its worktree binding, so --worktree is what puts it back in there.
// Not when the worktree is gone (folderGone): --worktree would make a new one.
export function resumeWorktreeName(session) {
  const wt = session && session.repo && session.repo.worktree
  const root = session && session.repo && session.repo.root
  if (!wt || !root || typeof wt !== 'string' || session.folderGone || isCodex(session)) return null
  const c = claudeWorktreeOf(wt)
  return c && trimSlash(c.root) === trimSlash(root) && trimSlash(c.path) === trimSlash(wt) ? c.name : null
}
export function resumeDir(session) {
  const cwd = session && session.cwd
  const wt = session && session.repo && session.repo.worktree
  if (resumeWorktreeName(session)) return session.repo.root
  if (cwd && wt && typeof wt === 'string' && (cwd === wt || String(cwd).startsWith(wt.replace(/\/+$/, '') + '/'))) return wt
  return cwd || null
}

// POSIX single quotes when needed (also right in fish).
export function shArg(s) {
  const v = String(s)
  return /^[A-Za-z0-9_./~@%+=:,-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'"
}

// ---------------------------------------------------------------- backend (0.6.8)
//
// Claude Code pointed at another server. `ollama launch claude --model M`
// (ollama/ollama cmd/launch/claude.go) runs `claude --model M [args after --]`
// with ANTHROPIC_BASE_URL = the Ollama host (OLLAMA_HOST, default
// http://127.0.0.1:11434, also for :cloud models: the local server forwards
// them), ANTHROPIC_AUTH_TOKEN=ollama, ANTHROPIC_API_KEY empty and
// ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL / CLAUDE_CODE_SUBAGENT_MODEL = M.
// We keep { kind: 'ollama', model, baseUrl } (the origin only) or, for any other
// non-Anthropic base URL, { kind: 'custom', host, model }. Never a token or key:
// the auth token is only compared with the literal "ollama".

const OLLAMA_PORT = '11434'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'])

// "opus", "sonnet[1m]", "claude-opus-4-5", "us.anthropic.claude-…": a Claude model or alias.
export function isClaudeModel(m) {
  const v = String(m || '').trim().toLowerCase()
  if (!v || v === '<synthetic>') return true
  return /claude/.test(v) || /^(opus|sonnet|haiku|opusplan|default|best)(\[1m\])?$/.test(v)
}

function httpUrl(raw) {
  try { const u = new URL(String(raw).trim()); return /^https?:$/.test(u.protocol) ? u : null } catch { return null }
}

export function isAnthropicHost(host) { return /(^|\.)anthropic\.com$/i.test(String(host || '')) }

// The model Claude Code really talks to: the session's model when it isn't a
// Claude name, else what the alias resolves to (ANTHROPIC_DEFAULT_*_MODEL),
// else ANTHROPIC_MODEL, else any tier's pin.
export function realModel(env = {}, model = null) {
  if (model && !isClaudeModel(model)) return String(model)
  const m = String(model || '').toLowerCase()
  const tier = /haiku/.test(m) ? env.ANTHROPIC_DEFAULT_HAIKU_MODEL : /sonnet/.test(m) ? env.ANTHROPIC_DEFAULT_SONNET_MODEL : env.ANTHROPIC_DEFAULT_OPUS_MODEL
  for (const c of [tier, env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL, env.CLAUDE_CODE_SUBAGENT_MODEL]) {
    if (c && String(c).trim() && !isClaudeModel(c)) return String(c).trim()
  }
  return null
}

// env (Claude Code's own) -> null (Anthropic) | { kind: 'ollama', model, baseUrl } | { kind: 'custom', host, model }
export function detectBackend(env = {}, { model = null } = {}) {
  const u = env.ANTHROPIC_BASE_URL ? httpUrl(env.ANTHROPIC_BASE_URL) : null
  if (!u || isAnthropicHost(u.hostname)) return null
  const host = u.hostname.toLowerCase()
  const real = realModel(env, model)
  const ollama = u.port === OLLAMA_PORT || /(^|\.)ollama\.com$/.test(host) || env.ANTHROPIC_AUTH_TOKEN === 'ollama'
  if (ollama) return stripNulls({ kind: 'ollama', model: real, baseUrl: u.origin })
  return stripNulls({ kind: 'custom', host: u.host, model: real })
}

// Whatever arrives on the wire or from a file -> a clean backend, or null.
export function cleanBackend(b) {
  if (!b || typeof b !== 'object') return null
  const model = typeof b.model === 'string' && b.model.trim() ? clip(b.model.trim(), 120) : null
  if (b.kind === 'ollama') {
    const u = b.baseUrl ? httpUrl(b.baseUrl) : null
    return stripNulls({ kind: 'ollama', model, baseUrl: u ? u.origin : null, inferred: b.inferred ? true : null })
  }
  if (b.kind === 'custom') {
    const host = typeof b.host === 'string' && b.host.trim() ? clip(b.host.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#@].*$/, ''), 120) : null
    return stripNulls({ kind: 'custom', host, model, inferred: b.inferred ? true : null })
  }
  return null
}

// A transcript's assistant message.model (what the server echoed) -> a backend
// for a session that has none (sessions from before 0.6.8). Only a model that
// isn't Claude's; an Ollama-style "name:tag" is taken as Ollama.
export function backendFromTranscriptModel(model) {
  if (!model || isClaudeModel(model)) return null
  const m = String(model).trim()
  return /^[\w.\-/]+:[\w.\-]+$/.test(m) ? { kind: 'ollama', model: m, inferred: true } : { kind: 'custom', model: m, inferred: true }
}

// "deepseek-v4-flash:cloud · Ollama" | "qwen3 · gw.example:4000" | "opus" | null
export function modelLabel(s) {
  const b = s && s.backend
  if (!b) return (s && s.model) || null
  const model = b.model || (s.model && !isClaudeModel(s.model) ? s.model : null)
  if (b.kind === 'ollama') return model ? model + ' · Ollama' : 'Ollama'
  const where = b.host || 'custom server'
  return model ? model + ' · ' + where : where
}

// Resuming through Ollama: `ollama launch claude --model M -- <claude args>`
// (docs.ollama.com/integrations/claude-code: arguments after -- go to Claude
// Code). OLLAMA_HOST is set only when the session used a non-default Ollama.
// Straight to ollama.com (no ollama launch): the env form, no key; the shell's
// own ANTHROPIC_AUTH_TOKEN signs in.
export function viaOllama(b) { return !!(b && b.kind === 'ollama' && !isOllamaCom(b.baseUrl)) }
function isOllamaCom(url) { const u = url ? httpUrl(url) : null; return !!(u && /(^|\.)ollama\.com$/i.test(u.hostname)) }

export function claudeInvocation(session, args = []) {
  const b = session && session.backend
  const tail = args.map(shArg).join(' ')
  if (b && b.kind === 'ollama') {
    if (isOllamaCom(b.baseUrl)) return 'ANTHROPIC_BASE_URL=' + shArg(b.baseUrl) + ' ANTHROPIC_API_KEY= claude' + (b.model ? ' --model ' + shArg(b.model) : '') + (tail ? ' ' + tail : '')
    const u = b.baseUrl ? httpUrl(b.baseUrl) : null
    const host = u && !(LOCAL_HOSTS.has(u.hostname) && u.port === OLLAMA_PORT && u.protocol === 'http:') ? 'OLLAMA_HOST=' + shArg(u.origin) + ' ' : ''
    return host + 'ollama launch claude' + (b.model ? ' --model ' + shArg(b.model) : '') + ' --' + (tail ? ' ' + tail : '')
  }
  return 'claude' + (tail ? ' ' + tail : '')
}

export function renderCheckpointMd(cp) {
  const fm = {
    id: cp.id,
    session_id: cp.sessionId,
    session_title: cp.sessionTitle || null,
    created_at: toIso(cp.createdAt),
    trigger: cp.trigger,
    machine: cp.machine || undefined,
    repo: cp.repo || null,
    branch: cp.branch || null,
    cwd: cp.cwd || null,
    files_touched: cp.filesTouched || [],
    turns_since_last: cp.turnsSinceLast == null ? null : cp.turnsSinceLast,
    user_note: cp.userNote || undefined,
    open_question: cp.openQuestion || undefined,
    parse_ok: cp.parseOk === false ? false : undefined,
    format: cp.format === 'markdown' ? 'markdown' : undefined,
    length: cp.length && SUMMARY_LENGTHS[cp.length] ? cp.length : undefined,
    generator: cp.generator ? toSnake(cp.generator) : { by: 'unknown' },
    schema: SCHEMA,
  }
  // 0.9.5: a markdown checkpoint keeps its lines: the ones after the first are
  // indented two spaces under their label (older readers take the first line).
  const field = cp.format === 'markdown' ? mdField : oneLine
  const lines = [
    '**Doing:** ' + field(cp.doing),
    '**Stopped at:** ' + field(cp.stoppedAt),
    '**Next:** ' + field(cp.next),
  ]
  if (cp.openQuestion) lines.push('**Open question:** ' + oneLine(cp.openQuestion))
  if (cp.userNote) lines.push('**Note:** ' + oneLine(cp.userNote))
  // Informative / long checkpoints (v0.4.6): sections below the three lines.
  // Older readers only pick up the **Label:** lines, so they still work.
  const bullet = (x) => '- ' + oneLine(x).replace(/^\*+/, '')
  for (const k of SECTION_ORDER) {
    const v = cp[k]
    if (k === 'recap') { if (v) lines.push('', '### ' + SECTION_TITLES[k], oneLine(v).replace(/^\*+/, '')); continue }
    if (!Array.isArray(v) || !v.length) continue
    lines.push('', '### ' + SECTION_TITLES[k])
    if (k === 'files') for (const f of v) lines.push(bullet(f.path ? '`' + String(f.path).replace(/`/g, '') + '`' + (f.why ? ' — ' + oneLine(f.why) : '') : f.why))
    else if (k === 'nextSteps') v.forEach((x, n) => lines.push((n + 1) + '. ' + oneLine(x).replace(/^\*+/, '')))
    else for (const x of v) lines.push(bullet(x))
  }
  const resume = resumeCommand({ id: cp.sessionId, cwd: cp.cwd, backend: cp.backend })
  return toFrontmatter(fm, CP_ORDER) + lines.join('\n') + '\n\nResume: `' + resume + '`\n'
}

function oneLine(s) { return String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').trim() }
function mdField(s) { return String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim().split('\n').map((l, i) => (i ? '  ' + l.replace(/\s+$/, '') : l)).join('\n') }

const BODY_FIELDS = { 'doing': 'doing', 'stopped at': 'stoppedAt', 'next': 'next', 'open question': 'openQuestion', 'note': 'userNote' }

export function parseCheckpointMd(text) {
  const { data, body } = parseFrontmatter(text)
  const cp = {
    id: data.id || null,
    sessionId: data.session_id || null,
    sessionTitle: data.session_title || null,
    createdAt: data.created_at ? toIso(data.created_at) : null,
    trigger: data.trigger || 'manual',
    machine: data.machine == null ? null : String(data.machine),
    repo: data.repo == null ? null : String(data.repo),
    branch: data.branch == null ? null : String(data.branch),
    cwd: data.cwd || null,
    filesTouched: Array.isArray(data.files_touched) ? data.files_touched.map(String) : [],
    turnsSinceLast: typeof data.turns_since_last === 'number' ? data.turns_since_last : null,
    userNote: data.user_note || null,
    openQuestion: data.open_question || null,
    parseOk: data.parse_ok === false ? false : true,
    ...(data.format === 'markdown' ? { format: 'markdown' } : {}),
    generator: data.generator && typeof data.generator === 'object' ? toCamel(data.generator) : { by: 'unknown' },
    length: data.length && SUMMARY_LENGTHS[data.length] ? data.length : null,
    doing: '', stoppedAt: '', next: '',
  }
  const lines = body.split('\n')
  let k = 0
  let open = null // 0.9.5: the field a markdown checkpoint's indented lines continue
  for (; k < lines.length; k++) {
    const line = lines[k]
    if (open && cp.format === 'markdown' && (/^  /.test(line) || (!line.trim() && /^  \S/.test(lines.slice(k + 1).find((x) => x.trim()) || '')))) { cp[open] += '\n' + line.slice(2); continue }
    open = null
    if (/^###\s/.test(line)) break // the sections of an informative / long checkpoint
    const m = line.match(/^\s*\*\*([A-Za-z ]+):\*\*\s*(.*)$/)
    if (!m) continue
    const f = BODY_FIELDS[m[1].trim().toLowerCase()]
    if (f) { cp[f] = m[2].trim(); open = f }
  }
  if (cp.format === 'markdown') for (const f of ['doing', 'stoppedAt', 'next']) cp[f] = cp[f].replace(/\n{3,}/g, '\n\n').trim()
  const sec = []
  for (; k < lines.length; k++) { if (/^Resume: `/.test(lines[k])) break; sec.push(lines[k]) }
  Object.assign(cp, parseSections(sec))
  return cp
}

// ---------------------------------------------------------------- background work (0.9.13)
//
// Claude Code's Stop hook says what is still in flight when a turn ends:
// background_tasks [{ id, type, status, description, command?, agent_type?, server?, tool?, name? }]
// and session_crons [{ id, schedule, recurring, prompt }]. The board shows
// "2 tasks running" with a tip naming them, so the session keeps a short list:
// at most BG_LIST_MAX entries of { kind, label }, each label at most
// BG_LABEL_MAX characters, a task's description before its raw command, and
// anything that looks like a secret (KEY=…, tokens, passwords) blanked out.

export const BG_LIST_MAX = 5
export const BG_LABEL_MAX = 60

const SECRET_NAME = '[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth(?!or)|credential|cookie|signature)[A-Za-z0-9_.-]*'
const SECRET_RES = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/=-]{6,}/gi, '$1 …'],
  [/\b(authorization|cookie|x-api-key)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+(?:\s+[A-Za-z0-9._~+\/=-]{12,})?)/gi, '$1$2…'],
  [/(:\/\/)[^\s\/@:]+:[^\s\/@]+@/g, '$1…@'], // https://user:pass@host
  [new RegExp('(--?' + SECRET_NAME + ')(=|\\s+)("[^"]*"|\'[^\']*\'|\\S+)', 'gi'), '$1$2…'], // --token abc, --api-key=abc
  [new RegExp('\\b(' + SECRET_NAME + ')(\\s*[=:]\\s*)("[^"]*"|\'[^\']*\'|[^\\s&;,]+)', 'gi'), '$1$2…'], // API_KEY=abc, token: abc, ?token=abc
  [/\b([A-Z][A-Z0-9_]{1,})=("[^"]*"|'[^']*'|[^\s;&|]+)/g, '$1=…'], // any env assignment: FOO=bar npm start
  [/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr|github_pat|glpat|xox[abprs]|AKIA|ASIA|npm|hf|ya29)[-_][A-Za-z0-9_-]{8,}/g, '…'],
  [/\bAKIA[A-Z0-9]{12,}\b/g, '…'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, '…'], // a JWT
  [/(?<![\/\w.-])(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{32,}(?![\/\w.-])/g, '…'], // a long random-looking string
]

// Blanks out what looks like a credential in a command line or a description.
export function redactSecrets(text) {
  let t = String(text == null ? '' : text)
  for (const [re, to] of SECRET_RES) t = t.replace(re, to)
  return t
}

// One short line: no "… [+N chars]" marker, no newlines, cut at a word with "…".
function bgText(v, max = BG_LABEL_MAX) {
  let t = redactSecrets(String(v == null ? '' : v).replace(/\s*…\s*\[\+\d+ chars\]\s*$/, '')).replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.·-]+$/, '') + '…'
}

const pad2 = (n) => String(n).padStart(2, '0')
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// "*/5 * * * *" → "every 5 min"; a schedule it can't put in words stays as written.
export function cronWords(schedule, recurring = true) {
  const f = String(schedule || '').trim().split(/\s+/)
  if (f.length !== 5) return recurring ? (String(schedule || '').trim() || 'scheduled') : 'once'
  const [mi, h, dom, mon, dow] = f
  const rest = dom === '*' && mon === '*'
  const at = /^\d+$/.test(h) && /^\d+$/.test(mi) ? Number(h) + ':' + pad2(Number(mi)) : null
  if (!recurring) return at ? 'once at ' + at : 'once'
  if (rest && dow === '*') {
    if (mi === '*' && h === '*') return 'every min'
    let m = /^\*\/(\d+)$/.exec(mi)
    if (m && h === '*') return 'every ' + Number(m[1]) + ' min'
    if (/^\d+$/.test(mi) && h === '*') return 'hourly'
    m = /^\*\/(\d+)$/.exec(h)
    if (m && /^\d+$/.test(mi)) return 'every ' + Number(m[1]) + ' h'
    if (at) return 'daily at ' + at
  }
  if (rest && at && dow === '1-5') return 'weekdays at ' + at
  if (rest && at && /^[0-6]$/.test(dow)) return DOWS[Number(dow)] + 's at ' + at
  return f.join(' ')
}

// One background task or session cron → { kind, label }, or null.
function bgEntry(x, cron) {
  if (!x || typeof x !== 'object') return null
  if (cron) {
    const when = cronWords(x.schedule, x.recurring !== false)
    const what = bgText(x.prompt || '', BG_LABEL_MAX)
    return { kind: 'cron', label: bgText(what ? when + ': ' + what : when) }
  }
  const kind = bgText(x.type || 'task', 20).toLowerCase() || 'task'
  const named = x.description || x.name ||
    (x.agent_type ? x.agent_type + ' agent' : '') ||
    (x.server || x.tool ? [x.server, x.tool].filter(Boolean).join(' · ') : '') ||
    x.command || ''
  const label = bgText(named)
  return { kind, label: label || kind }
}

// The Stop hook's two arrays → the session's short list (null when nothing runs).
export function backgroundListFrom(tasks, crons) {
  const out = []
  for (const t of Array.isArray(tasks) ? tasks : []) { const e = bgEntry(t, false); if (e) out.push(e) }
  for (const c of Array.isArray(crons) ? crons : []) { const e = bgEntry(c, true); if (e) out.push(e) }
  return out.length ? out.slice(0, BG_LIST_MAX) : null
}

// A list that came over the wire or from a synced record, made safe again.
export function cleanBackgroundList(list) {
  if (!Array.isArray(list)) return null
  const out = []
  for (const x of list) {
    if (!x || typeof x !== 'object') continue
    const label = bgText(x.label || '')
    if (!label) continue
    out.push({ kind: bgText(x.kind || 'task', 20).toLowerCase() || 'task', label })
    if (out.length >= BG_LIST_MAX) break
  }
  return out.length ? out : null
}

// ---------------------------------------------------------------- session markdown

const SESSION_ORDER = ['id', 'title', 'title_source', 'machine', 'cwd', 'repo', 'transcript_path', 'model', 'surface', 'capture',
  'status', 'started_at', 'last_activity_at', 'last_heartbeat_at', 'ended_at', 'end_reason', 'turns',
  'last_checkpoint_id', 'last_checkpoint_at', 'parent_session_id', 'pinned', 'archived', 'ignored', 'schema']

// Fields persisted so status survives a daemon restart (beyond the spec's Session JSON).
export const SESSION_EXTRA = ['inTurn', 'needsInput', 'backgroundTasks', 'turnsSinceCheckpoint', 'dormantStretch',
  'finalCheckpointDone', 'firstPrompt', 'lastPreview', 'lastNotification', 'lastEventAt', 'statusChanges', 'folder',
  'pid', 'tty', 'pidStartedAt', 'pidSource', 'term', 'closedAt', 'answers', 'lastNotificationMessage', 'needsInputAt', 'question', 'questionAt',
  'startSource', 'historyTurns', 'healedAt', 'healedVia', 'archivedReason', 'backend', 'prLinks', 'prUnlinked', 'todos', 'files', 'startRepo', 'editedRepos', 'parked', 'nonInteractive', 'transcriptCwd', 'doubtedCheckpoints', 'liveLink', 'transcriptTurns', 'wasLive', 'headless', 'startedFrom', 'startProject', 'backgroundList']

export const SESSION_FIELDS = ['id', 'title', 'titleSource', 'machine', 'cwd', 'repo', 'transcriptPath', 'model', 'surface', 'capture',
  'status', 'startedAt', 'lastActivityAt', 'lastHeartbeatAt', 'endedAt', 'endReason', 'turns', 'lastCheckpointId',
  'lastCheckpointAt', 'parentSessionId', 'pinned', 'archived', 'ignored', 'codingAgent']

export function renderSessionMd(session, checkpoints = []) {
  const fm = {}
  for (const k of SESSION_FIELDS) fm[camelToSnake(k)] = session[k] === undefined ? null : session[k]
  if (fm.repo && typeof fm.repo === 'object') fm.repo = toSnake(fm.repo)
  for (const k of SESSION_EXTRA) {
    if (k === 'folder' || k === 'statusChanges') continue
    if (session[k] !== undefined && session[k] !== null && session[k] !== '' && session[k] !== 0 && session[k] !== false) fm[camelToSnake(k)] = session[k]
  }
  fm.schema = SCHEMA
  const sorted = checkpoints.slice().sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
  const lines = ['# ' + (session.title || 'Untitled session'), '']
  const repo = repoName(session)
  const branch = session.repo && session.repo.branch
  lines.push('`' + repo + (branch ? ' · ' + branch : '') + '` · ' + (session.machine ? session.machine + ' · ' : '') + (session.status || 'unknown') + ' · started ' + (toIso(session.startedAt) || '?'))
  lines.push('')
  lines.push('Resume: `' + resumeCommand(session) + '`')
  lines.push('')
  lines.push('## Checkpoints')
  lines.push('')
  if (!sorted.length) lines.push('_None yet._')
  for (const cp of sorted) {
    const when = toIso(cp.createdAt).replace('T', ' ').slice(0, 16) + 'Z'
    lines.push('- [' + when + ' · ' + cp.trigger + '](checkpoints/' + (cp.file || checkpointFileName(cp.createdAt)) + ')' + (cp.next ? ' — Next: ' + clip(cp.next, 160) : ''))
  }
  return toFrontmatter(fm, SESSION_ORDER) + lines.join('\n') + '\n'
}

export function parseSessionMd(text) {
  const { data } = parseFrontmatter(text)
  const s = {}
  for (const [k, v] of Object.entries(data)) {
    if (k === 'schema') continue
    s[snakeToCamel(k)] = v
  }
  if (s.repo && typeof s.repo === 'object') s.repo = toCamel(s.repo)
  if (s.repo && typeof s.repo === 'string') s.repo = { root: null, name: s.repo }
  for (const k of ['startedAt', 'lastActivityAt', 'lastHeartbeatAt', 'endedAt', 'lastCheckpointAt', 'lastEventAt', 'dormantStretch', 'closedAt', 'pidStartedAt']) {
    if (s[k]) s[k] = toIso(s[k])
  }
  s.turns = typeof s.turns === 'number' ? s.turns : 0
  s.turnsSinceCheckpoint = typeof s.turnsSinceCheckpoint === 'number' ? s.turnsSinceCheckpoint : 0
  s.backgroundTasks = typeof s.backgroundTasks === 'number' ? s.backgroundTasks : 0
  if (s.backgroundList !== undefined) { const l = cleanBackgroundList(s.backgroundList); if (l) s.backgroundList = l; else delete s.backgroundList }
  s.pinned = !!s.pinned
  s.archived = !!s.archived
  if (s.backend !== undefined) { const b = cleanBackend(s.backend); if (b) s.backend = b; else delete s.backend }
  return s
}

// ---------------------------------------------------------------- tab titles and terminal identity (v0.4)
//
// The tab marker is "cp:<6 chars of the session id>". Before 0.5.5 the mod put
// it in every terminal tab title so `leftoff go` could find the tab by title;
// now it's added only when Go can't tell the tab apart by tty, name or folder. Claude Code repaints the title itself
// (✳/◐ + the session's name) about once a second while it works, so the mod
// sets the *session's* name with Claude Code's own /rename and lets Claude Code
// draw it; a raw OSC 2 write would be painted over within a second.

export function shortId(id) { const k = id8(id); return isTimeOrderedId(id) ? k.slice(-6) : k.slice(0, 6) }
export function tabMarker(id) { return 'cp:' + shortId(id) }

const MARKER_RE = /\s*(?:·|-|\|)?\s*cp:([a-z0-9]{6})\s*$/i

// "auth refactor · cp:7a1e0b" -> { name: "auth refactor", id: "7a1e0b" }; no marker -> { name, id: null }
export function parseTabTitle(title) {
  const t = String(title == null ? '' : title)
  const m = t.match(MARKER_RE)
  if (!m) return { name: t.trim(), id: null }
  return { name: t.slice(0, m.index).trim(), id: m[1].toLowerCase() }
}
export function stripTabMarker(title) { return parseTabTitle(title).name }
// Since 0.5.5 the mod's own tab title is usually the session's name alone (no
// marker), clipped to 60 characters: that coming back from Claude Code is the
// mod's own /rename, not a name you chose.
export function isOwnTabTitle(t, s) {
  if (!t || !s) return false
  if (parseTabTitle(t).id) return true
  const name = s.title || null
  return !!name && String(t).trim() === formatTabTitle('{name}', { name, id: s.id })
}

// 0.9.9: renames the mod does by itself (see applyTabTitle in register.js):
// a change of the marker alone, or the same title again, waits until the
// cool-down after the last one has passed; a new name never waits.
export const TAB_RENAME_COOLDOWN_MS = 10 * 60000
export function tabRenameWaits(last, title, { id, now, cooldownMs = TAB_RENAME_COOLDOWN_MS } = {}) {
  if (!last || last.id !== id || !(now - last.at < cooldownMs)) return false
  return title === last.title || parseTabTitle(title).name === parseTabTitle(last.title).name
}

// The default before 0.5.5: every tab title carried " · cp:<id>". A config
// that still says exactly that is treated as the new default ({name} alone).
export const LEGACY_TAB_TITLE_FORMAT = '{name} · cp:{id}'
export function effectiveTitleFormat(format) {
  if (typeof format !== 'string' || !format.trim() || format === LEGACY_TAB_TITLE_FORMAT) return DEFAULT_CONFIG.tabTitleFormat
  if (!/\{name\}|\{repo\}|\{id\}/.test(format)) return DEFAULT_CONFIG.tabTitleFormat
  return format
}

// "colorGenie", or "colorGenie · cp:207651" when `marker` is set: Go needs the
// marker only when it can't tell the tab apart otherwise (an older Ghostty
// without tty matching, and another open session with the same name or
// folder). A format with {id} in it always shows the id.
export function formatTabTitle(format, { name, id, repo, marker = false } = {}) {
  const fmt = effectiveTitleFormat(format)
  const clean = clip(stripTabMarker(name || '') || repo || 'claude', 60).replace(/[\x00-\x1f\x7f]/g, ' ')
  let out = fmt.replace(/\{name\}/g, clean).replace(/\{repo\}/g, String(repo || '').replace(/[\x00-\x1f\x7f]/g, ' ')).replace(/\{id\}/g, shortId(id)).replace(/\s+/g, ' ').trim()
  if (marker && id && !fmt.includes('{id}')) out += ' · ' + tabMarker(id)
  return out
}

// The environment variables that identify which terminal (and which tab or
// pane in it) a session runs in. Read once at session start.
export const TERM_ENV_KEYS = [
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM', 'GHOSTTY_RESOURCES_DIR', 'ITERM_SESSION_ID',
  'WEZTERM_PANE', 'WEZTERM_UNIX_SOCKET', 'KITTY_WINDOW_ID', 'KITTY_LISTEN_ON', 'TMUX', 'TMUX_PANE', 'TERM_SESSION_ID',
]

const LABELS = { ghostty: 'Ghostty', iterm2: 'iTerm2', wezterm: 'WezTerm', kitty: 'kitty', 'apple-terminal': 'Terminal.app', tmux: 'tmux', vscode: 'VS Code', unknown: 'unknown terminal' }

function outerTerminal(env) {
  const tp = String(env.TERM_PROGRAM || '')
  const term = String(env.TERM || '')
  const t = tp.toLowerCase()
  if (t === 'ghostty') return 'ghostty'
  if (t === 'iterm.app') return 'iterm2'
  if (t === 'wezterm') return 'wezterm'
  if (t === 'apple_terminal') return 'apple-terminal'
  if (t === 'vscode') return 'vscode'
  if (t === 'kitty' || env.KITTY_WINDOW_ID || term === 'xterm-kitty') return 'kitty'
  if (env.WEZTERM_PANE) return 'wezterm'
  if (env.ITERM_SESSION_ID) return 'iterm2'
  if (env.GHOSTTY_RESOURCES_DIR || term === 'xterm-ghostty') return 'ghostty'
  return 'unknown'
}

// env (any subset of TERM_ENV_KEYS) -> { kind, label, program, version, ...ids, host? }
export function detectTerminal(env = {}) {
  const e = env || {}
  const out = { kind: 'unknown', label: '', program: e.TERM_PROGRAM || null, version: e.TERM_PROGRAM_VERSION || null }
  const outer = outerTerminal(e)
  const ids = {}
  if (e.ITERM_SESSION_ID) { const s = String(e.ITERM_SESSION_ID); ids.itermSessionId = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s }
  if (e.WEZTERM_PANE) ids.weztermPane = String(e.WEZTERM_PANE)
  if (e.WEZTERM_UNIX_SOCKET) ids.weztermSocket = String(e.WEZTERM_UNIX_SOCKET)
  if (e.KITTY_WINDOW_ID) ids.kittyWindowId = String(e.KITTY_WINDOW_ID)
  if (e.KITTY_LISTEN_ON) ids.kittyListenOn = String(e.KITTY_LISTEN_ON)
  if (e.TERM_SESSION_ID) ids.termSessionId = String(e.TERM_SESSION_ID)
  if (e.TMUX && e.TMUX_PANE) {
    out.kind = 'tmux'
    out.tmuxPane = String(e.TMUX_PANE)
    out.tmuxSocket = String(e.TMUX).split(',')[0] || null
    out.host = outer === 'unknown' ? null : outer
    out.label = 'tmux' + (out.host ? ' in ' + LABELS[out.host] : '')
    return { ...out, ...ids }
  }
  out.kind = outer
  out.label = outer === 'unknown' ? (e.TERM_PROGRAM || e.TERM || 'unknown terminal') : LABELS[outer]
  // Where Ghostty.app lives, so Go can read its dictionary (does it have tty?) from the bundle.
  if (outer === 'ghostty' && e.GHOSTTY_RESOURCES_DIR) out.resourcesDir = String(e.GHOSTTY_RESOURCES_DIR)
  if (outer === 'vscode' && /cursor/i.test(String(e.TERM_PROGRAM_VERSION || ''))) out.label = 'Cursor'
  return { ...out, ...ids }
}

// `ps -o etime=` ("[[dd-]hh:]mm:ss") -> seconds, or null
export function parseEtime(s) {
  const m = String(s || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!m) return null
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + Number(m[3]) * 60 + Number(m[4])
}

// The tty column of `ps -o tty=` -> a device path, or null ("?", "??" = none)
export function ttyPath(t) {
  const s = String(t || '').trim()
  if (!s || /^\?+$/.test(s) || s === '-') return null
  if (s.startsWith('/dev/')) return s
  return '/dev/' + (/^s\d+$/.test(s) ? 'tty' + s : s) // macOS `ps -o tt` prints "s003" for /dev/ttys003
}

// One line from the mod's process probe: "<pid> <tty> <etime>" -> { pid, tty, pidStartedAt }
export function parseProcLine(line, now = Date.now()) {
  const parts = String(line || '').trim().split(/\s+/)
  const pid = Number(parts[0])
  if (!Number.isInteger(pid) || pid <= 1) return null
  const secs = parseEtime(parts[2])
  return { pid, tty: ttyPath(parts[1]), pidStartedAt: secs == null ? null : toIso(now - secs * 1000) }
}

// ---------------------------------------------------------------- status and dormancy

const MIN = 60000

export function computeStatus(s, now, cfg = DEFAULT_CONFIG) {
  if (s.endedAt) return 'ended'
  const lastActivity = ms(s.lastActivityAt || s.startedAt)
  const idle = isNaN(lastActivity) ? 0 : now - lastActivity
  const dormantAfter = cfg.dormantAfterMin * MIN
  if (s.capture === 'mod') {
    const hb = ms(s.lastHeartbeatAt || s.lastEventAt || s.startedAt)
    // A Claude Code process the daemon saw running recently isn't stale, even
    // if the mod's heartbeat lapsed (the laptop slept, the mod was slow).
    const seen = ms(s.pidAliveAt)
    const pidFresh = !isNaN(seen) && now - seen <= Math.max(cfg.staleAfterSec * 1000, 90000)
    if (!pidFresh && !isNaN(hb) && now - hb > cfg.staleAfterSec * 1000) return 'stale'
  }
  if (s.needsInput) return 'needs_input'
  if (s.inTurn) {
    // Hooks-only capture sees no event when a turn is interrupted (Stop does not
    // fire), so a turn that has been silent for twice the dormancy window is
    // treated as over. The mod sees turn.complete for aborted turns too.
    // 0.8.0: a Codex rollout shows no end for a turn Codex was killed in, either.
    if ((s.capture === 'hooks' || s.capture === 'codex') && idle >= 2 * dormantAfter) return 'dormant'
    return 'active'
  }
  if (s.backgroundTasks > 0) return 'background'
  return idle >= dormantAfter ? 'dormant' : 'waiting'
}

// Returns the trigger a checkpoint is due for now, or null.
export function checkpointDue(s, now, cfg = DEFAULT_CONFIG) {
  if (s.ignored) return null
  const status = computeStatus(s, now, cfg)
  const lastCp = ms(s.lastCheckpointAt)
  const lastActivity = ms(s.lastActivityAt || s.startedAt)
  const gapOk = isNaN(lastCp) || now - lastCp >= cfg.minGapMin * MIN
  const activitySinceCp = (s.turnsSinceCheckpoint || 0) > 0 || (!isNaN(lastActivity) && (isNaN(lastCp) ? !!s.lastActivityAt : lastActivity > lastCp))
  if (status === 'ended' || status === 'stale') {
    // v0.6.7: closing always leaves a checkpoint when anything happened since the
    // last one, even minutes after it (no minGap here): the Closed list and
    // Resume read it. Nothing new, or an empty session, still writes none.
    if (s.finalCheckpointDone || !activitySinceCp) return null
    if (!s.lastActivityAt) return null
    return s.endReason === 'clear' ? 'clear' : 'session_end'
  }
  const idle = now - lastActivity
  if (idle < cfg.dormantAfterMin * MIN) {
    if (cfg.longRunCheckpointMin && status === 'active' && s.activeSince) {
      const ref = Math.max(ms(s.activeSince), isNaN(lastCp) ? 0 : lastCp)
      if (now - ref >= cfg.longRunCheckpointMin * MIN && gapOk) return 'long_run'
    }
    return null
  }
  if (s.dormantStretch && s.dormantStretch === s.lastActivityAt) return null // one per idle stretch
  if (!gapOk) return null
  if (status === 'dormant' && (s.turnsSinceCheckpoint || 0) >= 1) return 'dormant'
  if (status === 'needs_input' && activitySinceCp) return 'dormant'
  return null
}

// Applies one wire event to a session record (mutates and returns it).
// Shared so the mod's own fallback registry and the daemon agree.
// v0.4.8: a session Leftoff knows nothing about yet: no turn, no name, no
// checkpoint, and not a resumed conversation. The board folds these into an
// "N empty sessions" row until their first prompt; the digest and restore skip them.
export function isEmptySession(s, checkpointCount = 0) {
  if (!s) return true
  // 0.7.1: a prompt counts. A long first turn (a worktree bug fix) has no completed turn yet.
  return !(Number(s.turns) > 0) && !(Number(s.transcriptTurns) > 0) && !s.title && !s.firstPrompt && !(Number(checkpointCount) > 0) && !s.lastCheckpointId &&
    !(Number(s.historyTurns) > 0) && s.startSource !== 'resume'
}

// The shape of the 0.4.6 "Untitled session" card: empty, and no folder or
// process either. Before 0.4.8 a daemon restart forgot an open session that
// had no turns yet, and the mod's next heartbeat made a bare record like this.
export function isGhostSession(s, checkpointCount = 0) {
  return isEmptySession(s, checkpointCount) && !s.cwd && !(Number(s.pid) > 1)
}

export function applyEvent(s, ev) {
  const at = toIso(ev.at) || toIso(Date.now())
  const d = ev.data || {}
  s.id = s.id || ev.sessionId
  s.capture = ev.capture || s.capture || 'hooks'
  if (ev.machine && !s.machine) s.machine = machineSlug(ev.machine)
  s.startedAt = s.startedAt || at
  s.lastEventAt = at
  const activity = () => { s.lastActivityAt = at; s.finalCheckpointDone = false; if (s.endedAt && ev.type !== 'session.ended') { s.endedAt = null; s.endReason = null; s.closedAt = null } }
  if (d.cwd) s.cwd = d.cwd
  if (d.transcriptPath) s.transcriptPath = d.transcriptPath
  if (d.model) s.model = d.model
  // 0.6.8: where the model runs. A capture that says null (Anthropic) clears it; no key leaves it.
  if ('backend' in d) { const b = cleanBackend(d.backend); if (b) s.backend = b; else delete s.backend }
  if (d.surface) s.surface = d.surface
  if (d.codingAgent) s.codingAgent = String(d.codingAgent) // 0.8.0: 'codex'; Claude Code sessions have none
  if (d.repo && typeof d.repo === 'object') s.repo = { ...(s.repo || {}), ...stripNulls(d.repo) }
  // A title carrying our own tab marker came from the mod's /rename: it is the
  // tab label, not a name the user chose, so it never overwrites the title.
  // 0.8.6: Claude Code's own generated title (the status line hears it as
  // session_name). It names the session unless you named it yourself.
  if (typeof d.generatedTitle === 'string' && d.generatedTitle.trim() && !parseTabTitle(d.generatedTitle).id && !isOwnTabTitle(d.generatedTitle, s) && !['custom', 'manual'].includes(s.titleSource) && d.generatedTitle.trim() !== s.title) { s.title = clip(d.generatedTitle.trim(), 120); s.titleSource = 'claude' }
  if (d.sessionTitle && !parseTabTitle(d.sessionTitle).id && d.sessionTitle !== s.title && !isOwnTabTitle(d.sessionTitle, s)) { s.title = d.sessionTitle; s.titleSource = 'custom' }
  if (d.proc && typeof d.proc === 'object' && Number(d.proc.pid) > 1) {
    s.pid = Number(d.proc.pid)
    s.tty = d.proc.tty || null
    s.pidStartedAt = d.proc.pidStartedAt || null
    s.pidSource = d.proc.source || (s.capture === 'mod' ? 'mod' : 'hook')
  }
  if (d.term && typeof d.term === 'object') s.term = d.term
  else if (d.termEnv && typeof d.termEnv === 'object') s.term = detectTerminal(d.termEnv)
  // 0.8.2: a parked session comes back by itself. Resumed (claude --resume, a
  // reopened process, codex resume) or a new prompt after the park clears it;
  // replayed older events (a Codex rollout read again) don't.
  if (s.parked && ms(at) > ms(s.parked.at) && unparks(s, ev, d)) delete s.parked
  switch (ev.type) {
    case 'session.parked': {
      const prevLock = s.parked && s.parked.worktreeLock // parked again: the lock it already holds stays on record
      s.parked = { at, note: d.note ? clip(String(d.note).replace(/\s+/g, ' ').trim(), 300) || null : null, checkpoint: d.checkpoint ? String(d.checkpoint) : null, by: d.by ? String(d.by) : null }
      // 0.8.8: the worktree /cp-park (or Park) locked, so it can be unlocked later
      if (d.worktreeLock && typeof d.worktreeLock === 'object' && typeof d.worktreeLock.path === 'string' && typeof d.worktreeLock.reason === 'string') s.parked.worktreeLock = { path: d.worktreeLock.path, root: typeof d.worktreeLock.root === 'string' ? d.worktreeLock.root : null, reason: d.worktreeLock.reason }
      else if (prevLock) s.parked.worktreeLock = prevLock
      break
    }
    case 'session.unparked':
      delete s.parked
      break
    case 'session.opened':
      s.lastHeartbeatAt = at
      if (s.endedAt) { s.endedAt = null; s.endReason = null; s.closedAt = null } // reopened (claude --resume) in a new process
      break
    case 'session.started':
      if (d.parentSessionId && d.parentSessionId !== s.id) s.parentSessionId = d.parentSessionId
      if (d.source === 'resume' || d.source === 'fork' || d.source === 'clear') { s.endedAt = null; s.endReason = null; s.closedAt = null }
      if (d.source === 'resume') s.startSource = 'resume' // a conversation that already had turns before Leftoff saw this process
      if (s.capture === 'mod') s.lastHeartbeatAt = at
      break
    case 'activity':
      if (d.kind === 'name') break // 0.8.6: a title heard by the status line is not activity
      activity()
      if (d.kind === 'tool' && d.phase === 'post' && s.needsInput && (s.lastNotification === 'permission_prompt' || s.capture === 'codex')) { s.needsInput = false; if (s.capture === 'codex') s.lastNotification = null }
      if (d.kind === 'prompt') {
        s.needsInput = false
        s.question = null
        s.lastNotification = null
        if (d.prompt && (!s.firstPrompt || /^\s*<channel\b/.test(s.firstPrompt))) s.firstPrompt = clip(stripChannel(d.prompt), 300) || s.firstPrompt || null // 0.9.8: a Live link message, without its wrapper (even one the 300-character clip cut short)
        if (d.countTurn === true) s.turns = (s.turns || 0) + 1 // 0.8.1: Codex counts a turn at its prompt when no task_started came first
        if (s.capture === 'hooks') { s.inTurn = true; s.activeSince = s.activeSince || at }
      }
      break
    case 'turn_started':
      activity()
      s.inTurn = true
      s.needsInput = false
      s.question = null
      s.activeSince = s.activeSince || at
      if (d.countTurn === true) s.turns = (s.turns || 0) + 1 // 0.8.1: Codex counts a turn when it starts
      break
    case 'turn_completed':
      activity()
      s.inTurn = false
      s.activeSince = null
      s.needsInput = false
      if (d.countTurn !== false && !d.again) s.turns = (s.turns || 0) + 1 // false: Codex already counted it at the start
      if (!d.again) s.turnsSinceCheckpoint = (s.turnsSinceCheckpoint || 0) + 1 // again (0.9.9): a late report of a turn already ended and counted
      s.backgroundTasks = Number(d.backgroundTasks || 0) + Number(d.sessionCrons || 0)
      s.backgroundList = s.backgroundTasks > 0 ? cleanBackgroundList(d.backgroundList) : null // 0.9.13: what's running, for the board's tip (an older mod sends counts only)
      if (d.lastAssistantPreview) s.lastPreview = clip(d.lastAssistantPreview, 280)
      // Claude ended the turn on a question to you (v0.4.4): the board offers a reply.
      s.question = d.question ? clip(d.question, 400) : null
      s.questionAt = d.question ? at : null
      break
    case 'notification':
      s.lastNotification = d.notificationType || null
      s.lastNotificationMessage = d.message ? clip(d.message, 200) : null
      if (NEEDS_INPUT_NOTIFICATIONS.includes(d.notificationType) || /^elicitation/.test(d.notificationType || '')) {
        if (!s.needsInput) s.needsInputAt = at
        s.needsInput = true
      }
      break
    case 'title_changed':
      if (d.title && stripTabMarker(d.title)) { s.title = stripTabMarker(d.title); s.titleSource = d.titleSource || 'custom' }
      break
    case 'heartbeat':
      s.lastHeartbeatAt = at
      if (typeof d.inTurn === 'boolean' && !d.inTurn && s.inTurn && s.capture === 'mod') s.inTurn = false
      break
    case 'session.ended':
      s.endedAt = at
      s.endReason = d.reason || 'other'
      s.inTurn = false
      break
  }
  return s
}

// 0.8.2: does this event bring a parked session back?
function unparks(s, ev, d) {
  if (ev.type === 'session.opened') return !d.again // a new process (claude --resume); the mod's hello again is the same one
  if (ev.type === 'session.started') return d.source === 'resume' && !!s.endedAt
  if (ev.type === 'turn_started') return true
  if (ev.type === 'activity') return d.kind === 'prompt'
  return false
}

// /cp-park [note] -> { note } (quotes around the whole note are dropped)
export function parseParkArgs(args) {
  let note = String(args == null ? '' : args).replace(/\s+/g, ' ').trim()
  const q = note.match(/^(["'“‘])(.*)(["'”’])$/)
  if (q) note = q[2].trim()
  return { note: note ? clip(note, 300) : null }
}

// ------------------------------------------------------------ parked worktrees (0.8.8)
// Claude Code removes a session's worktree when the session exits and the
// worktree has no changes (code.claude.com/docs/en/worktrees, "Clean up
// worktrees"), and /cp-park exits. So in a linked git worktree, park first
// locks it (`git worktree lock --reason …`). Claude Code's exit cleanup keeps a
// worktree locked with a reason it didn't write, and its stale-lock sweep only
// releases its own "claude agent|session … (pid N)" locks, so the reason must
// never start with "claude ". Resume, Done with it, or the session coming back
// unlocks it. Only a lock with this exact session's reason is ever unlocked.
// run(argv) -> { code | exitCode, stdout, stderr }: $.process.run in the mod,
// execFile in the daemon, a fake in tests. Nothing here deletes anything.
export const PARK_LOCK_PREFIX = 'leftoff: parked session '
export function parkLockReason(sessionId) {
  return PARK_LOCK_PREFIX + String(sessionId || '') + ' (resume it, or press Done with it on the board, to unlock)'
}
// a lock reason -> the session id Leftoff parked, or null for any other lock
export function parkLockSession(reason) {
  const m = /^leftoff: parked session ([A-Za-z0-9-]{4,80})(?: |$)/.exec(String(reason == null ? '' : reason))
  return m ? m[1] : null
}

// `git worktree list --porcelain` -> [{ path, branch, bare, detached, locked: null | reason ('' when none given) }]
export function parseWorktreeList(text) {
  const out = []
  let cur = null
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null, bare: false, detached: false, locked: null }; out.push(cur); continue }
    if (!cur) continue
    if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'bare') cur.bare = true
    else if (line === 'detached') cur.detached = true
    else if (line === 'locked') cur.locked = ''
    else if (line.startsWith('locked ')) cur.locked = line.slice(7)
  }
  return out
}

const runCode = (r) => (r == null ? null : r.code != null ? r.code : r.exitCode != null ? r.exitCode : null)
const trimSlash = (p) => String(p || '').replace(/\/+$/, '') || '/'
const firstLine = (s) => String(s || '').trim().split('\n')[0].slice(0, 200)
// a path inside Claude Code's own worktrees folder: <repo>/.claude/worktrees/<name>[/…]
export function claudeWorktreeOf(dir) {
  const m = /^(.*)\/\.claude\/worktrees\/([^/]+)(?:\/.*)?$/.exec(trimSlash(dir))
  return m ? { root: m[1] || '/', name: m[2], path: m[1] + '/.claude/worktrees/' + m[2] } : null
}

// Is dir in a linked git worktree? -> { kind: 'worktree', top, root, gitDir, commonDir }
// | { kind: 'none' } (not in git, or the main checkout) | { kind: 'unknown', why }
export async function worktreeAt(run, dir) {
  if (!dir) return { kind: 'unknown', why: 'no folder on record' }
  let r
  try { r = await run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']) } catch (e) { return { kind: 'unknown', why: 'git didn’t run (' + firstLine(e && e.message) + ')' } }
  if (runCode(r) !== 0) {
    if (/not a git repository/i.test(String(r && r.stderr))) return claudeWorktreeOf(dir) ? { kind: 'unknown', why: 'git doesn’t see a repository there' } : { kind: 'none' }
    return { kind: 'unknown', why: 'git: ' + (firstLine(r && r.stderr) || 'exit ' + runCode(r)) }
  }
  const [gitDir, commonDir, top] = String(r.stdout || '').trim().split('\n').map((x) => trimSlash(x.trim()))
  if (!gitDir || !commonDir || !top) return { kind: 'unknown', why: 'git gave no answer' }
  if (gitDir === commonDir) return { kind: 'none' } // the main checkout (or a submodule, its own repo)
  return { kind: 'worktree', top, gitDir, commonDir, root: /\/\.git$/.test(commonDir) ? commonDir.slice(0, -5) || '/' : commonDir }
}

function findEntry(list, path, reason) {
  const p = trimSlash(path)
  return list.find((e) => trimSlash(e.path) === p) || (reason ? list.find((e) => e.locked === reason) : null) || null
}

// /cp-park (and Park on the board): lock the worktree dir is in, then read it
// back. -> { worktree: null } (not a worktree: nothing to protect)
//  | { worktree, root, locked: true, reason } (locked and checked)
//  | { worktree, root?, locked: false, why } (not protected: don't exit for them)
export async function lockForPark(run, dir, sessionId) {
  const w = await worktreeAt(run, dir)
  if (w.kind === 'none') return { worktree: null }
  if (w.kind === 'unknown') { const g = claudeWorktreeOf(dir); return { worktree: g ? g.path : null, locked: false, why: w.why, unsure: true } }
  const reason = parkLockReason(sessionId)
  let lockErr = ''
  try { const r = await run(['git', '-C', w.top, 'worktree', 'lock', '--reason', reason, w.top]); if (runCode(r) !== 0) lockErr = firstLine(r && r.stderr) || 'exit ' + runCode(r) } catch (e) { lockErr = firstLine(e && e.message) }
  let list = null
  try { const l = await run(['git', '-C', w.top, 'worktree', 'list', '--porcelain']); if (runCode(l) === 0) list = parseWorktreeList(l.stdout) } catch {}
  const base = { worktree: w.top, root: w.root }
  if (!list) return { ...base, locked: false, why: 'couldn’t read the lock back' + (lockErr ? ' (' + lockErr + ')' : '') }
  const e = findEntry(list, w.top, reason)
  if (e && e.locked === reason) return { ...base, locked: true, reason }
  if (e && e.locked != null) return { ...base, locked: false, why: 'it’s already locked' + (e.locked ? ' (“' + clip(e.locked, 80) + '”)' : ''), foreign: true }
  return { ...base, locked: false, why: lockErr || 'the lock didn’t take' }
}

// Is the lock still there, with our reason? (checked again right before /exit)
export async function parkLockHeld(run, path, reason) {
  try {
    const l = await run(['git', '-C', path, 'worktree', 'list', '--porcelain'])
    if (runCode(l) !== 0) return false
    const e = findEntry(parseWorktreeList(l.stdout), path, reason)
    return !!(e && e.locked === reason)
  } catch { return false }
}

// Unlock what Leftoff locked for this session: every worktree of the repo at
// dir whose lock reason is this session's park reason. Any other lock (yours,
// Claude Code's) is left alone. -> { unlocked: [path], failed: [{ path, why }], error? }
export async function unlockParkLocks(run, dir, sessionId) {
  const out = { unlocked: [], failed: [] }
  if (!dir || !sessionId) return out
  let list
  try {
    const l = await run(['git', '-C', dir, 'worktree', 'list', '--porcelain'])
    if (runCode(l) !== 0) return { ...out, error: firstLine(l && l.stderr) || 'git worktree list failed' }
    list = parseWorktreeList(l.stdout)
  } catch (e) { return { ...out, error: firstLine(e && e.message) } }
  for (const e of list) {
    if (e.locked == null || parkLockSession(e.locked) !== String(sessionId)) continue
    try {
      const r = await run(['git', '-C', dir, 'worktree', 'unlock', e.path])
      if (runCode(r) === 0) out.unlocked.push(e.path)
      else out.failed.push({ path: e.path, why: firstLine(r && r.stderr) || 'exit ' + runCode(r) })
    } catch (err) { out.failed.push({ path: e.path, why: firstLine(err && err.message) }) }
  }
  return out
}

// What /cp-park says about the worktree. res: lockForPark's answer.
export function parkWorktreeText(res) {
  if (!res || !res.worktree && !res.unsure) return ''
  if (!res.worktree && !res.locked) return ' Leftoff couldn’t tell whether this is a worktree session (' + (res.why || 'no answer') + '), so it didn’t close it. If it is one, lock it first (`git worktree lock <worktree>`) or choose Keep if Claude Code asks: on /exit, Claude Code removes a worktree that has no changes.'
  if (res.locked) return ' This is a worktree session, so Leftoff locked the worktree first: Claude Code will say it kept it (“could not be removed”). Resume or Done with it unlocks it.'
  const where = res.worktree ? ' ' + shArg(res.worktree) : ''
  return ' This is a worktree session and Leftoff couldn’t lock it (' + (res.why || 'no answer') + '), so it didn’t close the session: on /exit, Claude Code removes a worktree that has no changes. To keep it, run `git worktree lock' + (where || ' <worktree>') + '` first, or choose Keep if Claude Code asks.'
}

// The question Claude ended its turn on, if it ended on one: the last paragraph
// of the answer when its last sentence ends with "?" (markdown and closing
// quotes ignored). Code blocks don't count. -> string or null
export function trailingQuestion(text) {
  let t = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim()
  if (!t) return null
  if (/```\s*$/.test(t)) return null
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  let last = paras[paras.length - 1] || ''
  const bare = last.replace(/[\s*_`)\]"'”’»]+$/u, '')
  if (!/[?？]$/.test(bare)) return null
  // A list of options under a lead-in question: keep the lead-in with them.
  if (paras.length > 1 && /^([-*•]|\d+[.)])\s/.test(last) && /[?:]\s*$/.test(paras[paras.length - 2])) last = paras[paras.length - 2] + '\n' + last
  last = last.replace(/^#+\s*/, '').replace(/[*_`]+$/, '')
  return last.length > 400 ? '…' + last.slice(-399) : last
}

function stripNulls(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v != null) r[k] = v; return r }

// ---------------------------------------------------------------- checkpoint input

export function compileRedactions(patterns = []) {
  const out = []
  for (const p of patterns) {
    try {
      let src = String(p), flags = 'g'
      if (src.startsWith('(?i)')) { src = src.slice(4); flags = 'gi' }
      out.push(new RegExp(src, flags))
    } catch { /* bad pattern: skipped */ }
  }
  return out
}

export function redact(text, patterns) {
  let s = String(text == null ? '' : text)
  for (const re of compileRedactions(patterns)) s = s.replace(re, '[REDACTED]')
  return s
}

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

function relPath(p, cwd) {
  const s = String(p || '')
  if (cwd && s.startsWith(cwd.replace(/\/+$/, '') + '/')) return s.slice(cwd.replace(/\/+$/, '').length + 1)
  return s
}

export function toolTarget(tool, input = {}, cwd) {
  const i = input || {}
  if (i.file_path) return relPath(i.file_path, cwd)
  if (i.notebook_path) return relPath(i.notebook_path, cwd)
  if (i.command) return clip(i.command, 80)
  if (i.pattern) return clip(i.pattern, 60)
  if (i.url) return clip(i.url, 80)
  if (i.path) return relPath(i.path, cwd)
  if (i.description) return clip(i.description, 60)
  return ''
}

export function filesTouched(messages, cwd) {
  const seen = []
  for (const m of messages || []) {
    for (const t of m.toolUses || []) {
      const name = t.tool || t.name
      const fp = t.input && (t.input.file_path || t.input.notebook_path)
      if (EDIT_TOOLS.includes(name) && fp) {
        const r = relPath(fp, cwd)
        if (!seen.includes(r)) seen.push(r)
      }
    }
  }
  return seen
}

// messages: [{ role, text, toolUses: [{ tool, input, isError, text }], toolResults? }]
// (the shape of $.session.messages(); the daemon's transcript parser produces the same)
export function transcriptSlice(messages, { maxInputChars = 24000, cwd } = {}) {
  const blocks = []
  let total = 0, lastErrorTaken = false
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i]
    const lines = []
    if (m.role === 'user') {
      if (m.text && m.text.trim()) { const t = stripChannel(m.text); if (t) lines.push('USER: ' + t) } // 0.9.9: a Live message's words, not its wrapper
      if (!lastErrorTaken) {
        const err = (m.toolResults || []).find((r) => r.isError)
        if (err) { lines.push('LAST ERROR: ' + clip(err.text, 500)); lastErrorTaken = true }
      }
    } else {
      if (m.text && m.text.trim()) lines.push('ASSISTANT: ' + clip(m.text, 1500))
      for (const t of m.toolUses || []) {
        const name = t.tool || t.name
        let line = '  -> ' + name + (toolTarget(name, t.input, cwd) ? ' ' + toolTarget(name, t.input, cwd) : '')
        if (t.isError) {
          line += ' -> error'
          if (!lastErrorTaken && t.text) { line += ': ' + clip(t.text, 500); lastErrorTaken = true }
        }
        lines.push(line)
      }
    }
    if (!lines.length) continue
    const block = lines.join('\n')
    if (total + block.length > maxInputChars && blocks.length) break
    blocks.push(block)
    total += block.length + 1
  }
  return blocks.reverse().join('\n')
}

// ---------------------------------------------------------------- checkpoint length (v0.4.6)
//
// config summary.length picks how much a checkpoint says. Every length keeps the
// three lines (Doing / Stopped at / Next) the board, the pane and the digest use;
// the longer ones add sections below them. `/cp --short` / `/cp --long` override
// the setting for one checkpoint.
export const SUMMARY_LENGTHS = {
  short: { label: 'Short', maxTokens: 300, approx: '~300 tokens', blurb: 'Doing / Stopped at / Next. Three lines, nothing else.' },
  informative: { label: 'Informative', maxTokens: 700, approx: '~700 tokens', blurb: 'The three lines, plus key decisions, open questions, files touched and why, and what didn\'t work.' },
  long: { label: 'Long', maxTokens: 1500, approx: '~1500 tokens', blurb: 'Everything in Informative, plus a short narrative recap and the next 3 steps.' },
}
export const SUMMARY_LENGTH_NAMES = Object.keys(SUMMARY_LENGTHS)
export const DEFAULT_SUMMARY_LENGTH = 'informative'

// 'Long' / 'medium' / 'default' / junk -> one of SUMMARY_LENGTH_NAMES (or null for junk when strict).
export function normalizeLength(v, { strict = false } = {}) {
  const k = String(v == null ? '' : v).trim().toLowerCase()
  if (SUMMARY_LENGTHS[k]) return k
  const alias = { s: 'short', brief: 'short', i: 'informative', info: 'informative', medium: 'informative', normal: 'informative', default: 'informative', l: 'long', full: 'long', detailed: 'long' }[k]
  if (alias) return alias
  return strict ? null : DEFAULT_SUMMARY_LENGTH
}
export function summaryLength(cfg = DEFAULT_CONFIG, override) {
  if (override) { const o = normalizeLength(override, { strict: true }); if (o) return o }
  return normalizeLength(cfg && cfg.summary && cfg.summary.length)
}

// "/cp --long fix the flaky test" -> { length: 'long', note: 'fix the flaky test' }.
// Recognised anywhere in the args: --short, --informative, --long, --length=<x>,
// -s / -l. Everything else is the note, as typed.
export function parseCheckpointArgs(args) {
  let length = null
  const rest = []
  for (const w of String(args || '').trim().split(/\s+/).filter(Boolean)) {
    const m = w.match(/^--length=(\w+)$/i)
    if (m && normalizeLength(m[1], { strict: true })) { length = normalizeLength(m[1], { strict: true }); continue }
    const f = w.match(/^--?(short|informative|info|long|s|l)$/i)
    if (f) { length = normalizeLength(f[1], { strict: true }); continue }
    rest.push(w)
  }
  return { length, note: rest.join(' ') || null }
}

const CHECKPOINT_BASE = [
  'You write checkpoints for a developer juggling many coding-agent sessions. Given the recent transcript of ONE session, start with exactly these three lines:',
  'Doing: <what the session was working on, one sentence, concrete nouns: files, features, errors>',
  'Stopped at: <the exact state when it went quiet: what passed, what failed, what is half-done>',
  'Next: <the single next action a human or the agent should take>',
  'If the session is blocked on the human (a question, a permission, a decision), start Next with "YOU:".',
  'Describe only what the transcript shows; the lines above it (repo, branch, title, previous checkpoint) are background and may be out of date.',
]
const INFORMATIVE_SECTIONS = [
  'Then these sections, each a heading line followed by "- " bullets (write "- none" when there is nothing; never invent):',
  'Decisions:',
  '- <a decision made in the session and the reason, one line each, at most 4>',
  'Open questions:',
  '- <an unresolved question or uncertainty, at most 3>',
  'Files:',
  '- <path> — <why it was touched, a few words; at most 6 files>',
  'Didn\'t work:',
  '- <an approach that was tried and abandoned or failed, and why; at most 3>',
]
const LONG_SECTIONS = [
  'Then:',
  'Recap: <a narrative paragraph of 4-7 sentences: the goal, how the session got here, the current state>',
  'Next steps:',
  '1. <the next step>',
  '2. <the step after>',
  '3. <the step after that>',
]
export const CHECKPOINT_SYSTEMS = {
  short: [...CHECKPOINT_BASE, 'Write only those three lines.', 'Optionally a 4th line "Title: <max 6 words>" if asked for a title.', 'No preamble. No markdown. Under 60 words total.'].join('\n'),
  informative: [...CHECKPOINT_BASE, ...INFORMATIVE_SECTIONS, 'Optionally a final line "Title: <max 6 words>" if asked for a title.', 'No preamble. No other markdown. Under 250 words total.'].join('\n'),
  long: [...CHECKPOINT_BASE, ...INFORMATIVE_SECTIONS, ...LONG_SECTIONS, 'Optionally a final line "Title: <max 6 words>" if asked for a title.', 'No preamble. No other markdown. Under 600 words total.'].join('\n'),
}
// The short prompt, as before v0.4.6 (kept under its old name for anything importing it).
export const CHECKPOINT_SYSTEM = CHECKPOINT_SYSTEMS.short

export function buildCheckpointPrompt({ session, previous, messages, cfg = DEFAULT_CONFIG, wantTitle = false, userNote, length }) {
  const len = summaryLength(cfg, length)
  const maxInputChars = (cfg.summarizer && cfg.summarizer.maxInputChars) || 24000
  const cwd = session.cwd
  const files = filesTouched(messages, cwd)
  const branch = session.repo && session.repo.branch
  const prev = previous ? ['Doing: ' + previous.doing, 'Stopped at: ' + previous.stoppedAt, 'Next: ' + previous.next].join('\n') : 'none'
  const head = [
    'Repo: ' + repoName(session) + (branch ? ' (branch ' + branch + ')' : '') + ' · cwd ' + (cwd || '?'),
    'Title: ' + (session.title || '(none yet)'),
    'Previous checkpoint: ' + prev,
    'Files touched since then: ' + (files.length ? files.join(', ') : 'none'),
  ]
  if (userNote) head.push('Note from the developer: ' + userNote)
  if (session.needsInput) head.push('State: the session is waiting on the developer (' + (session.lastNotification || 'a prompt') + ').')
  if (wantTitle) head.push('Also write the line: Title: <max 6 words>.')
  const slice = transcriptSlice(messages, { maxInputChars, cwd })
  const patterns = (cfg.redact && cfg.redact.patterns) || []
  const prompt = redact(head.join('\n') + '\nTranscript (oldest→newest, trimmed):\n' + (slice || '(empty)'), patterns)
  return { system: CHECKPOINT_SYSTEMS[len], prompt, filesTouched: files, inputChars: prompt.length, length: len, maxTokens: SUMMARY_LENGTHS[len].maxTokens }
}

// The extra sections of an informative / long checkpoint, by the heading a
// model (or a checkpoint file) uses for them.
const SECTION_KEYS = {
  'decisions': 'decisions', 'key decisions': 'decisions',
  'open questions': 'questions', 'questions': 'questions',
  'files': 'files', 'files touched': 'files',
  'didn\'t work': 'didntWork', 'didnt work': 'didntWork', 'did not work': 'didntWork', 'what didn\'t work': 'didntWork', 'what didnt work': 'didntWork', 'tried': 'didntWork',
  'recap': 'recap',
  'next steps': 'nextSteps', 'next 3 steps': 'nextSteps',
}
export const SECTION_TITLES = { decisions: 'Key decisions', questions: 'Open questions', files: 'Files touched', didntWork: 'What didn\'t work', recap: 'Recap', nextSteps: 'Next steps' }
const SECTION_ORDER = ['decisions', 'questions', 'files', 'didntWork', 'recap', 'nextSteps']
const NONE_RE = /^(none|n\/a|nothing|-|—|none yet|no(ne)? (open )?questions?)\.?$/i
const LIMITS = { decisions: 6, questions: 5, files: 10, didntWork: 5, nextSteps: 5 }

// "src/a.js — retry loop" / "`src/a.js`: why" -> { path, why }
export function parseFileNote(text) {
  const t = String(text || '').trim()
  const m = t.match(/^`?([^`\s][^`]*?)`?\s*(?:—|–|-{1,2}|:)\s+(.+)$/)
  if (m && /[./]/.test(m[1]) && !/\s/.test(m[1].trim())) return { path: m[1].trim(), why: m[2].trim() }
  const p = t.match(/^`?([^`\s]+)`?$/)
  return p ? { path: p[1], why: '' } : { path: '', why: t }
}

function emptyExtras() { return { decisions: [], questions: [], files: [], didntWork: [], recap: '', nextSteps: [] } }
export function hasExtras(cp) {
  return !!cp && (['decisions', 'questions', 'files', 'didntWork', 'nextSteps'].some((k) => Array.isArray(cp[k]) && cp[k].length) || !!cp.recap)
}

// Section lines (after the three main lines) -> the extras. Shared by the
// model-reply parser and the checkpoint-file parser.
function parseSections(lines) {
  const ex = emptyExtras()
  let cur = null
  const push = (k, v) => {
    v = String(v || '').replace(/\*\*/g, '').trim()
    if (!v || NONE_RE.test(v)) return
    if (k === 'recap') { ex.recap = ex.recap ? ex.recap + ' ' + v : v; return }
    if (k === 'files') { const f = parseFileNote(v); if (f.path || f.why) ex.files.push(f); return }
    ex[k].push(v)
  }
  for (const raw of lines) {
    const line = String(raw).trim()
    if (!line) continue
    const h = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/^_+|_+$/g, '').trim()
    const hm = h.match(/^([A-Za-z' ’0-9]+?)\s*:\s*(.*)$/) || h.match(/^([A-Za-z' ’0-9]+?)$/)
    const key = hm ? SECTION_KEYS[hm[1].replace(/’/g, '\'').trim().toLowerCase()] : null
    if (key && (hm[2] !== undefined || /^#/.test(line) || !cur)) {
      cur = key
      if (hm[2]) push(key, hm[2].replace(/^[-*•]\s*/, ''))
      continue
    }
    if (!cur) continue
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/)
    if (item) push(cur, item[1])
    else if (cur === 'recap') push(cur, line)
    else if (/^(doing|stopped at|next|title|open question|note|resume)\s*:/i.test(h)) cur = null
    else push(cur, line)
  }
  for (const k of Object.keys(LIMITS)) ex[k] = ex[k].slice(0, LIMITS[k])
  ex.recap = clip(ex.recap, 1600)
  return ex
}

export function parseCheckpointReply(text) {
  const out = { doing: '', stoppedAt: '', next: '', title: null, openQuestion: null, parseOk: true }
  const map = { 'doing': 'doing', 'stopped at': 'stoppedAt', 'next': 'next', 'title': 'title', 'open question': 'openQuestion' }
  const rest = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^[\s*_#>-]+/, '').replace(/\*\*/g, '')
    const m = line.match(/^(doing|stopped at|next|title|open question)\s*:\s*(.+)$/i)
    if (m) out[map[m[1].toLowerCase()]] = m[2].trim()
    else rest.push(raw)
  }
  if (!out.doing || !out.stoppedAt || !out.next) {
    // 0.9.5: not the format asked for (a small model's markdown write-up): read what we can
    // from its headings and labels, keep the whole text (no 600-character cut), mark it.
    return { ...salvageCheckpointReply(text), title: out.title ? clip(out.title.replace(/^["']|["']$/g, ''), 60) : null }
  }
  if (out.title) out.title = clip(out.title.replace(/^["']|["']$/g, ''), 60)
  return { ...out, ...parseSections(rest) }
}

// 0.9.5: a reply that didn't follow the format, read leniently. Headings
// (### Summary), bold labels (**Status:** …, **Next steps**) and plain labels
// (Next: …) map onto the three fields; whatever doesn't map stays in Doing.
// The markdown is kept as written (the session page renders it; cards and the
// digest strip it), up to MD_CAP characters a field.
export const MD_CAP = 8000
const SALVAGE_KEYS = [
  ['doing', /^(doing|what i'?m doing|what i am doing|working on|what was being done|summary|overview|tl;?dr|current (task|work|focus)|task|goal|context|what happened|background)$/],
  ['stoppedAt', /^(stopped( at)?|where (it|we|i|things) (stopped|left off|stands?)|left off|status|current status|state|current state|progress|where things stand|last step|result|results|outcome)$/],
  ['next', /^(next|next steps?|what'?s next|to ?dos?|todo list|next actions?|remaining( work)?|follow[- ]?ups?|action items?|recommendations?)$/],
]
function salvageKey(label) {
  const l = String(label || '').replace(/[’`]/g, '\'').replace(/\*\*|__/g, '').replace(/^[^A-Za-z]+/, '').replace(/[\s:.\-–—]+$/, '').trim().toLowerCase()
  if (!l || l.length > 40) return null
  // "Session summary", "Summary of the session", "Current status", "Next steps for the PR"
  const core_ = l.replace(/^(the|my|our|session|current|work|overall)\s+/, '').replace(/\s+(of|for|on|so far|in)\b.*$/, '').trim()
  for (const [k, re] of SALVAGE_KEYS) if (re.test(l) || re.test(core_)) return k
  return null
}
const capText = (s) => { const t = String(s || '').replace(/\n{3,}/g, '\n\n').trim(); return t.length > MD_CAP ? t.slice(0, MD_CAP - 1).trimEnd() + '…' : t }
export function salvageCheckpointReply(text) {
  const buckets = { doing: [], stoppedAt: [], next: [], rest: [] }
  let cur = 'rest'
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    let m
    if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*$/))) {
      const k = salvageKey(m[1])
      if (k) { cur = k; continue }
      cur = 'rest'; buckets.rest.push(line); continue
    }
    if ((m = line.match(/^\s*(?:[-*+]\s+)?(?:\*\*|__)([^*_]{1,40}?)(?:\*\*|__)\s*(:?)\s*(.*)$/))) {
      const label = m[1].replace(/:\s*$/, '')
      const k = (m[1].trim().endsWith(':') || m[2] || !m[3]) ? salvageKey(label) : null
      if (k) { cur = k; if (m[3].trim()) buckets[k].push(m[3].trim()); continue }
    }
    if ((m = line.match(/^\s*([A-Za-z][A-Za-z '’]{1,30}):\s*(.*)$/))) {
      const k = salvageKey(m[1])
      if (k) { cur = k; if (m[2].trim()) buckets[k].push(m[2].trim()); continue }
    }
    buckets[cur].push(line)
  }
  const doing = capText([...buckets.doing, ...(buckets.doing.length && buckets.rest.some((x) => x.trim()) ? [''] : []), ...buckets.rest].join('\n'))
  return { doing: doing || '(empty reply)', stoppedAt: capText(buckets.stoppedAt.join('\n')), next: capText(buckets.next.join('\n')), title: null, openQuestion: null, parseOk: false, format: 'markdown', ...emptyExtras() }
}
// Of two salvaged replies (the first and the retry's), the one that filled more fields.
export function betterSalvage(a, b) {
  const score = (r) => (r && r.stoppedAt ? 1 : 0) + (r && r.next ? 1 : 0)
  return score(b) > score(a) ? b : a
}
// The retry's prompt: the same request, with the format restated plainly.
export const RETRY_REMINDER = '\n\nIMPORTANT: your reply must use exactly this format, starting with the first line. No headings (#), no bold (**), no preamble:\nDoing: <one or two sentences>\nStopped at: <one or two sentences>\nNext: <one sentence>\n(Then the section headings above, if this length asks for them.)'
export const retryCheckpointPrompt = (prompt) => String(prompt || '') + RETRY_REMINDER

// 0.9.2: a checkpoint written with nothing to go on: no prompt and no reply were
// found (the heuristic's placeholder lines). Never saved; old ones are set aside.
export function isEmptyCheckpoint(cp) {
  return !!cp && /^No prompt captured yet\.?$/.test(String(cp.doing || '').trim()) && /^No reply captured yet\.?$/.test(String(cp.stoppedAt || '').trim())
}
export const NOTHING_TO_CHECKPOINT = 'Nothing to checkpoint yet — no messages found for this session'

// 0.9.9: Leftoff's Live wrapper, <channel source="leftoff" …>words</channel>,
// off a prompt: the words only (several, nested, or cut short by a 300-character
// clip). The board and the daemon use ui/cp-text.js stripChannel; this copy is
// here because the mod ships on its own. A test holds the two to the same answers.
const CH_PAIR = /<channel\b[^>]*>([\s\S]*?)<\/channel\s*>/g
export function stripChannel(s) {
  let t = String(s == null ? '' : s)
  if (!/<\/?channel\b/i.test(t)) return t.trim()
  for (let i = 0; i < 8 && CH_PAIR.test(t); i++) { CH_PAIR.lastIndex = 0; t = t.replace(CH_PAIR, '$1') }
  CH_PAIR.lastIndex = 0
  t = t.replace(/<channel\b[^>]*>/g, '').replace(/<\/channel\s*>/g, '').replace(/<\/?channel\b[^>]*$/, '')
  return t.trim()
}
// 0.9.9: a reply's list kept readable in one line: "…two things: - A. - B." →
// "…two things: a; b." (a copy of ui/cp-text.js joinListText; a test holds them equal).
const LIST_LEAD = /^(?:A|An|The|Added|Removed|Changed|Fixed|Updated|Moved|Renamed|Created|Deleted|Wrote|Made|Kept|Put|Ran|Used)\b/
const itemCase = (x) => (LIST_LEAD.test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x)
export function joinListLines(t) {
  const s = String(t == null ? '' : t)
  if (!/(^|\n|:)\s*(?:[-*+•]|\d{1,3}[.)])\s+\S/.test(s)) return s
  let out = '', inList = false
  for (const raw of s.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/(?<=:)\s+(?=(?:[-*+•]|\d{1,3}[.)])\s+\S)/)
    for (const part of parts) {
      const m = part.match(/^(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/)
      if (m) {
        const item = itemCase(m[1].replace(/\s+(?:[-*+•])\s+(?=\S)/g, '; ').replace(/[\s.;,]+$/, ''))
        out += inList ? '; ' + item : (/:$/.test(out) ? ' ' : out ? ': ' : '') + item
        inList = true
      } else {
        if (inList) out += '.'
        out += (out ? ' ' : '') + part
        inList = false
      }
    }
  }
  if (inList) out += '.'
  return out.replace(/\s+/g, ' ').replace(/\.\.$/, '.').trim()
}

// No model available: build a checkpoint from the last prompt and the last reply.
// Informative / long add what can be read off the transcript without a model:
// the files edited (with the tool), the failed tool calls, the questions asked.
// 0.9.9: prompts without the Live wrapper; no "Resume the session and continue
// from the last reply." Next is a concrete step (an ask, Claude's question, the
// last error, edited files not yet committed) or empty.
export function heuristicCheckpoint(messages, session = {}, { length = 'short', cwd } = {}) {
  const ms_ = (messages || []).map((m) => (m && m.role === 'user' && typeof m.text === 'string' && /<\/?channel\b/i.test(m.text) ? { ...m, text: stripChannel(m.text) } : m))
  const lastUser = [...ms_].reverse().find((m) => m.role === 'user' && m.text && m.text.trim())
  const lastAssistant = [...ms_].reverse().find((m) => m.role === 'assistant' && m.text && m.text.trim())
  let lastError = null
  for (let i = ms_.length - 1; i >= 0 && !lastError; i--) {
    const m = ms_[i]
    const e1 = (m.toolResults || []).find((r) => r.isError)
    const e2 = (m.toolUses || []).find((t) => t.isError)
    if (e1) lastError = e1.text
    else if (e2) lastError = e2.text || (e2.tool + ' failed')
    if (m === lastAssistant && !lastError) break
  }
  const firstSentence = (t) => { const s = clip(joinListLines(String(t || '').slice(0, 1200)), 400); const m = s.match(/^(.{20,240}?[.!?])(\s|$)/); return m ? m[1] : clip(s, 240) }
  const firstLine = (t) => String(t || '').split('\n').map((x) => x.trim()).find(Boolean) || ''
  const first = session.firstPrompt ? stripChannel(session.firstPrompt) : ''
  const doing = lastUser ? 'Working on: “' + clip(firstLine(lastUser.text), 140) + '”' : (first ? 'Working on: “' + clip(first, 140) + '”' : 'No prompt captured yet.')
  const stoppedAt = lastError ? 'Last error: ' + clip(lastError, 200) : lastAssistant ? firstSentence(lastAssistant.text) : (session.lastPreview ? firstSentence(session.lastPreview) : 'No reply captured yet.')
  // edited files with no `git commit` after the last edit
  let lastEdit = -1, lastCommit = -1
  ms_.forEach((m, i) => {
    for (const t of m.toolUses || []) {
      const name = t.tool || t.name
      if (EDIT_TOOLS.includes(name) && !t.isError) lastEdit = i
      if (name === 'Bash' && t.input && /\bgit\b[^\n]*\bcommit\b/.test(String(t.input.command || '')) && !t.isError) lastCommit = i
    }
  })
  let next = ''
  const tail = lastAssistant ? clip(lastAssistant.text, 4000).slice(-300) : ''
  const q = tail.match(/([^.!?\n]{8,200}\?)\s*$/)
  if (session.needsInput) next = 'YOU: answer the pending ' + String(session.lastNotification || 'prompt').replace(/_/g, ' ') + ' in this session.'
  else if (q) next = 'YOU: ' + clip(q[1].trim(), 180)
  else if (lastError) next = 'Look at the last error and decide whether to retry or change approach.'
  else if (lastEdit >= 0 && lastCommit < lastEdit) next = 'Commit, or keep going.'
  const base = { doing, stoppedAt, next, title: null, openQuestion: null, parseOk: true }
  const len = normalizeLength(length)
  if (len === 'short') return base
  const ex = emptyExtras()
  const dir = cwd || session.cwd
  const seen = new Map()
  for (const m of ms_) for (const t of m.toolUses || []) {
    const name = t.tool || t.name
    const fp = t.input && (t.input.file_path || t.input.notebook_path)
    if (EDIT_TOOLS.includes(name) && fp) { const r = relPath(fp, dir); if (!seen.has(r)) seen.set(r, name === 'Write' ? 'written' : 'edited') }
    if (t.isError && ex.didntWork.length < LIMITS.didntWork) ex.didntWork.push(clip(name + (toolTarget(name, t.input, dir) ? ' ' + toolTarget(name, t.input, dir) : '') + ' failed' + (t.text ? ': ' + t.text.split('\n')[0] : ''), 200))
  }
  ex.files = [...seen].slice(-LIMITS.files).map(([path, why]) => ({ path, why }))
  for (const m of ms_) if (m.role === 'assistant' && m.text) { const qq = trailingQuestion(m.text); if (qq && !ex.questions.includes(qq)) ex.questions.push(clip(qq, 200)) }
  ex.questions = ex.questions.slice(-LIMITS.questions)
  if (len === 'long') {
    const firstUser = ms_.find((m) => m.role === 'user' && m.text && m.text.trim())
    const prompts = ms_.filter((m) => m.role === 'user' && m.text && m.text.trim()).length
    ex.recap = [
      firstUser ? 'The session started with: “' + clip(firstUser.text.split('\n')[0], 160) + '”.' : '',
      prompts > 1 ? 'There were ' + prompts + ' prompts since.' : '',
      seen.size ? seen.size + ' file' + (seen.size === 1 ? ' was' : 's were') + ' changed.' : '',
      lastError ? 'The last tool call failed.' : '',
      'Written without a model, from the transcript alone.',
    ].filter(Boolean).join(' ')
    ex.nextSteps = next ? [next] : []
  }
  return { ...base, ...ex }
}

// Fallback title: {repo}@{branch} · {first 6 words of the first prompt}
export function fallbackTitle(session) {
  const words = String(session.firstPrompt || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 6).join(' ')
  const branch = session.repo && session.repo.branch
  return repoName(session) + (branch ? '@' + branch : '') + (words ? ' · ' + words : '')
}

// 0.9.9: the title is in the language the user writes in (English when unsure),
// one language, one script: a small local model once named an English session
// "Ants README笑话" ("joke" in Chinese).
export const TITLE_LANGUAGE = 'Write it in the same language as the user\'s own messages (English if unsure), in one language only: never mix in words or characters from another language.'
export const TITLE_SYSTEM = 'Write a title of at most 6 words for a coding session, based on its first prompt. ' + TITLE_LANGUAGE + ' Reply with the title only, no quotes, no punctuation at the end.'

export function cleanTitle(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n').map((l) => l.trim()).find(Boolean) || ''
  return clip(t.replace(/^title\s*:\s*/i, '').replace(/^["'`*]+|["'`*.]+$/g, ''), 60)
}

// The writing systems in a text's letters (digits, punctuation and emoji have none).
// Chinese and Japanese characters count as one ("han").
const SCRIPTS = [
  ['latin', /\p{Script=Latin}/u], ['han', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u], ['hangul', /\p{Script=Hangul}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u], ['greek', /\p{Script=Greek}/u], ['arabic', /\p{Script=Arabic}/u], ['hebrew', /\p{Script=Hebrew}/u],
  ['thai', /\p{Script=Thai}/u], ['devanagari', /\p{Script=Devanagari}/u],
]
export function scriptsOf(text) {
  const out = new Set()
  for (const ch of String(text || '')) {
    if (!/\p{L}/u.test(ch)) continue
    const hit = SCRIPTS.find(([, re]) => re.test(ch))
    out.add(hit ? hit[0] : 'other')
  }
  return out
}
// Does a generated title keep to the user's writing? Every script in it must
// be one the user wrote in; Latin letters are always fine (file names, code,
// "README"). A title that brings in another script is dropped for the fallback.
export function titleFitsUser(title, userText) {
  const mine = scriptsOf(userText)
  for (const sc of scriptsOf(title)) if (sc !== 'latin' && !mine.has(sc)) return false
  // 0.9.11: same alphabet, other language ("Gestus multiquestionum explicandi" for an English prompt)
  if (looksEnglish(userText) && !titleLooksEnglish(title, userText)) return false
  return true
}
// 0.9.11: a small local model titled an English session in Latin ("Gestus
// multiquestionum explicandi"): same alphabet, so the script check above let
// it through. For a prompt that is clearly English, the title must look English
// too: most of its words are common English, the prompt's own words (plurals
// and simple stems allowed), or English by their endings. Code names, file
// names and acronyms (element_epoch_ms, driverFactory, README) don't count
// either way; a Spanish/French/German/Latin function word the prompt never used
// ("de", "des", "und", "et") is a giveaway on its own. No dictionary to install.
const EN_FUNCTION = new Set(('the a an and or but if then so of to in on at by for from with without into onto about over under after before ' +
  'is are was were be been being am do does did done has have had having can could will would should shall may might must ' +
  'i me my we us our you your he him his she her it its they them their this that these those there here what which who whom whose ' +
  'when where why how not no yes all any some each every both more most less many much few other another such only own same ' +
  'than too very just also again still now today up down out off via per as because while until since though although whether ' +
  'let lets please hey hi thanks ok okay one two three first last next new old way something anything nothing everything').split(' '))
const EN_WORDS = new Set([...EN_FUNCTION, ...('add added adding adds allow api app apps ask asks asking answer answers auth auto backend background bad base ' +
  'basic batch better big board bot box branch break broken bug bugs build builds button cache call calls card cards case change changes chat check checks ' +
  'clean cleanup clear cli click client close code column columns command commit config connect copy core count create cron css current dark data ' +
  'date db debug default delete deploy design detail details dev diff doc docs driver drop edit editor element empty end error errors event events ' +
  'explain export extra fail fails failing fast feature field fields file files filter find fix fixes flag flaky flow folder font form format ' +
  'full get git give go good graph group grouping guard guide handle handler header help hide history hook hooks host icon idea image import ' +
  'improve info input install issue issues item items job jobs join json key keys kind label layout lazy line lines link links lint list lists ' +
  'live load local lock log logic login logs look loop main make map mark menu merge message messages method migrate mobile mode model module ' +
  'move multi name names nav note notes number open option options order output overview page pages panel parse parser part pass patch path ' +
  'phone pick plan play polish port post prompt prompts proof pull push query question questions queue quick read readme real record refactor ' +
  'release remote remove rename render repo report request reset response rest result results retry review route router rule run runs runner ' +
  'save scan schema screen script scroll search session sessions set setup ship show sidebar sign size slow small sort source spec split ' +
  'start state status step stop store style sync table tables tag task tasks test tests text theme time timeout tip title titles today token ' +
  'tool tools top track tree trim try tune type typo typos ui undo unit up update upgrade url use user users value values view wait warn watch ' +
  'web wire word words work worker write wrong yaml focus bonus plus bus virus menu cursor ' +
  'support transcript transcripts tidy bump speed toggle suite crash startup prototype investigate audit align avoid batch bind boot cancel cap ' +
  'cart chart cleanup compare compose convert cover cut define detect disable enable draft drag embed ensure expose extract fetch finish fit ' +
  'fold forms gate handoff hover inline keep limit lint map match measure memo mock mute note pin poll port preview profile prune rate ' +
  'reach rebase redo reduce refresh reload repair replace reply resize resolve restore reuse revert rework rewrite scope seed send serve ' +
  'share shrink skip slot snap spike stub swap tidy trace tweak unify unlock untangle verify wrap zoom basics summary context notes intro').split(' ')])
const FOREIGN_FUNCTION = new Set(('de del la las el los un una unos unas y con para por que como sobre su sus ' + // es
  'le les des du une et pour avec sur dans au aux ce cette ces est ' + // fr
  'der das und mit für fur von zu auf ein eine einen dem ist nicht über uber ' + // de
  'gli della delle dei di per con nel ' + // it
  'uma não nao ' + // pt
  'cum est sunt atque quae qui quod').split(' ').filter((w) => !EN_WORDS.has(w)))
const FOREIGN_ENDING = /(?:um|us|ae|orum|arum|ibus|andi|endi|ando|endo|ione|ioni|zione|mente|ieren|ung|ungen|heit|keit|lich|chen|ção|ción|ciones)$/
const EN_ENDING = /(?:ing|ings|tion|tions|sion|sions|ment|ments|ness|ity|ities|able|ible|ize|izes|ized|ise|ful|less|ship|ism|ist|ists|ward|wise|ed|ly|er|ers)$/
const isCodeish = (w) => /[\d_./\\@#:$]/.test(w) || /[a-z][A-Z]/.test(w) || (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w))
const promptWords = (text) => String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').toLowerCase().match(/[\p{L}']+/gu) || []
const stem = (w) => w.replace(/'s$/, '').replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s)$/, '')
// Is this prompt clearly written in English? (Enough English function words, few foreign ones.)
export function looksEnglish(text) {
  const words = promptWords(text)
  if (!words.length) return false
  let en = 0, fo = 0
  for (const w of words) { if (EN_FUNCTION.has(w)) en++; else if (FOREIGN_FUNCTION.has(w)) fo++ }
  return en >= 2 && en / words.length >= 0.1 && fo * 3 <= en
}
// For an English prompt: does the title read as English? (See above.)
export function titleLooksEnglish(title, userText) {
  const mine = new Set(), mineStems = new Set()
  for (const w of promptWords(userText)) { mine.add(w); mineStems.add(stem(w)) }
  const known = (w) => EN_WORDS.has(w) || mine.has(w) || EN_WORDS.has(stem(w)) || mineStems.has(stem(w)) ||
    [...mineStems].some((p) => p.length >= 4 && (w.startsWith(p) ? w.length - p.length <= 3 : p.startsWith(w) && w.length >= 4 && p.length - w.length <= 3))
  const english = (w) => known(w) || (/^[a-z]+$/.test(w) && !FOREIGN_ENDING.test(w) && (EN_ENDING.test(w) || /w|k|th|sh|ck|gh|y$/.test(w)))
  let ok = 0, bad = 0
  const raws = String(title || '').split(/\s+/).filter(Boolean)
  const mixedCase = raws.slice(1).some((w) => /^[a-z]/.test(w)) // not Title Case: a capital mid-title is a name
  for (const [i, raw] of raws.entries()) {
    const tok = raw.replace(/^[^\p{L}\p{N}_`]+|[^\p{L}\p{N}_`]+$/gu, '')
    if (!tok || /`/.test(tok) || isCodeish(tok)) continue
    const parts = tok.toLowerCase().split(/[-']/).filter(Boolean)
    if (!parts.length) continue
    if (parts.length === 1 && FOREIGN_FUNCTION.has(parts[0]) && !mine.has(parts[0])) return false
    if (parts.every(english)) ok++
    else if (mixedCase && i > 0 && /^[A-Z][a-z]+$/.test(tok) && !FOREIGN_ENDING.test(tok.toLowerCase())) continue // a name mid-title (Codex, Stripe)
    else bad++
  }
  return ok >= bad
}

// The line under a title prompt that pins the language. 0.9.11: it no longer
// says "Latin letters" (a 3B model may read that as "write in Latin"); a prompt
// that is clearly English gets "English" by name. firm: the retry's stricter line.
export function titleLanguageLine(userText, { firm = false } = {}) {
  const mine = scriptsOf(userText)
  if ([...mine].some((sc) => sc !== 'latin')) return firm ? 'Title language: the language of the messages above, every word in that one language (code names may stay as written).' : 'Title language: the language of the messages above.'
  if (looksEnglish(userText)) return firm ? 'Title language: English. Use plain everyday English words only, no other language; code names from the prompt may stay as written.' : 'Title language: English, plain English words (English if unsure), the English alphabet only.'
  return firm ? 'Title language: the language of the messages above (English if unsure), every word in that one language.' : 'Title language: the language of the messages above (English if unsure), the same alphabet only.'
}

// ---------------------------------------------------------------- catch me up (v0.5.0)

// A model reply -> its bullet lines (at most max), or null when fewer than two.
export function parseBulletList(text, max = 6) {
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const out = []
  for (const line of clean.split('\n')) {
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/)
    if (m) out.push(m[1].replace(/\*\*/g, '').trim())
  }
  if (out.length < 2) return null
  return out.slice(0, max)
}

const CATCHUP_WINDOW_WORD = /^(last|since-last|\d+(?:\.\d+)?(?:m|min|h|hr|d|w|wk)|workday|last-workday|today|yesterday|(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?|\d{4}-\d{2}-\d{2})$/i

// /cp-catchup [window] [repo ...] [all|here]: "3d leftoff site", "friday", "here".
export function parseCatchupArgs(args) {
  const words = String(args || '').trim().split(/\s+/).filter(Boolean)
  const o = { since: null, repos: [], here: false, all: false }
  for (const w of words) {
    const k = w.replace(/^--?/, '')
    if (!o.since && CATCHUP_WINDOW_WORD.test(k)) o.since = k
    else if (/^(all|everything)$/i.test(k)) o.all = true
    else if (/^(here|this)$/i.test(k)) o.here = true
    else o.repos.push(...k.split(',').filter(Boolean))
  }
  if (o.all) o.repos = []
  return o
}

// ---------------------------------------------------------------- lists (v0.5.1)
//
// Checklists Claude writes ("- [ ] …", or numbered / bulleted next steps under
// a heading), saved as plain Markdown in lists/<repo>/<slug>.md. Item numbers
// are stable: an item keeps its number for good (a hidden "<!-- #3 … -->"
// after it), new items get the next one, and nothing is renumbered when items
// are ticked or a hand edit moves them.

const LIST_FENCE = /^\s*(```|~~~)/
const LIST_CHECK = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+\[( |x|X)\]\s+(.*\S)\s*$/
const LIST_NUM = /^(\s*)(\d{1,3})[.)]\s+(.*\S)\s*$/
const LIST_BUL = /^(\s*)[-*+•]\s+(.*\S)\s*$/
const LIST_HEAD = /^\s*(?:#{1,6}\s+(.+?)\s*#*|\*\*(.+?)\*\*\s*:?|__(.+?)__\s*:?|(\S[^\n]{0,100}?)\s*:)\s*$/
export const LIST_STEP_WORDS = /\b(need to|you'?ll have to|make sure|in order to|do next|to do|how to|instructions|checklist|next(?: steps?)?|steps?|to-?dos?|tasks?|plan|remaining|follow[- ]?ups?|action items?|check-?list|left to do|what'?s left|still to do|open items?|road ?map|phases?|milestones?|punch ?list|before (?:we|you|i) (?:ship|merge|launch))\b/i

function listItemText(s) {
  return String(s || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/\s*<!--.*?-->\s*$/, '').replace(/\s+/g, ' ').trim()
}
function listMarker(line) {
  let m = line.match(LIST_CHECK)
  if (m) return { indent: m[1].replace(/\t/g, '  ').length, done: m[2] !== ' ', checkbox: true, text: m[3] }
  m = line.match(LIST_NUM)
  if (m) return { indent: m[1].replace(/\t/g, '  ').length, done: false, checkbox: false, numbered: true, n: Number(m[2]), text: m[3] }
  m = line.match(LIST_BUL)
  if (m && !/^[-*_]{3,}$/.test(line.trim())) return { indent: m[1].replace(/\t/g, '  ').length, done: false, checkbox: false, text: m[2] }
  return null
}
export function cleanListHeading(h) {
  return String(h || '').replace(/^#+\s*/, '').replace(/\*\*|__/g, '').replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim()
}

// The lists in one message's text, in order. A checklist ("- [ ]" / "- [x]")
// always counts; a numbered or bulleted list counts when the heading or lead-in
// line just above it names steps, a plan, todos, next steps and the like.
// Lists inside code fences are not lists. Nested lines belong to the item above.
export function listsInText(text, { minItems = 2 } = {}) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inFence = false, heading = null, headingAt = -10
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (LIST_FENCE.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (!line.trim()) continue
    const first = listMarker(line)
    if (!first) {
      const h = line.match(LIST_HEAD)
      if (h) { heading = cleanListHeading(h[1] || h[2] || h[3] || h[4]); headingAt = i } else { heading = null }
      continue
    }
    // a list starts here
    const base = first.indent
    const items = [{ text: listItemText(first.text), done: first.done, checkbox: first.checkbox, numbered: !!first.numbered }]
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (LIST_FENCE.test(l)) break
      if (!l.trim()) {
        let k = j + 1
        while (k < lines.length && !lines[k].trim()) k++
        const nx = k < lines.length ? listMarker(lines[k]) : null
        if (nx && nx.indent <= base + 1) { j = k - 1; continue }
        break
      }
      const mk = listMarker(l)
      const ind = l.match(/^\s*/)[0].replace(/\t/g, '  ').length
      if (mk && mk.indent <= base + 1) { items.push({ text: listItemText(mk.text), done: mk.done, checkbox: mk.checkbox, numbered: !!mk.numbered }); continue }
      if (ind > base) {
        // a nested bullet folds into the item above ("Prepare assets — icon; screenshots");
        // a wrapped line continues it
        const last = items[items.length - 1]
        const t = listItemText(mk ? mk.text : l)
        if (last && t) last.text = mk ? (last.sub ? last.text + '; ' + t : last.text + ' — ' + t) : last.text + ' ' + t
        if (last && mk) last.sub = true
        continue
      }
      break
    }
    const checks = items.filter((x) => x.checkbox).length
    const near = heading && headingAt >= i - 3 ? heading : null
    const kind = checks >= Math.ceil(items.length / 2) ? 'checklist' : items.every((x) => x.numbered) ? 'numbered' : 'bulleted'
    const counts = kind === 'checklist' || (near && LIST_STEP_WORDS.test(near))
    const real = items.filter((x) => x.text)
    if (counts && real.length >= minItems) out.push({ kind, heading: near, items: real.map((x) => ({ text: x.text, done: !!x.done })), line: i })
    heading = null
    i = j - 1
  }
  return out
}

// Every list Claude wrote in a session, oldest first, numbered 1..n.
// messages: the $.session.messages() / transcript shape.
export function extractChecklists(messages, { minItems = 2, fallback = null } = {}) {
  const out = []
  ;(messages || []).forEach((m, mi) => {
    if (!m || m.role !== 'assistant' || !m.text) return
    for (const c of listsInText(m.text, { minItems })) out.push({ ...c, message: mi, at: m.at || null })
  })
  return out.map((c, k) => ({ ...c, n: k + 1, name: listAutoName(c, { fallback }) }))
}

// How alike two item lists are (0..1): the share of the shorter one's items
// the other also has. A list Claude repeats with some boxes ticked is the same list.
const normItem = (t) => String(t || '').toLowerCase().replace(/[`*_~]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
export function listSimilarity(a, b) {
  const A = (a || []).map((x) => normItem(x.text || x)).filter(Boolean), B = new Set((b || []).map((x) => normItem(x.text || x)).filter(Boolean))
  if (!A.length || !B.size) return 0
  const hit = A.filter((t) => B.has(t)).length
  return hit / Math.min(A.length, B.size)
}
export function listFingerprint(items) {
  let h = 2166136261
  for (const ch of (items || []).map((x) => normItem(x.text || x)).join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

// A list's name from its heading: "Here are the next steps to submit to the
// App Store:" -> "Next steps to submit to the App Store". No heading -> the
// fallback (the caller passes the session's title), else "Checklist".
export function listAutoName(c, { fallback = null } = {}) {
  let h = cleanListHeading(c && c.heading)
  h = h.split(/(?<=[.!?])\s+/).pop() // "Build is green. Here are the next steps…" -> the last sentence
  h = h.replace(/^(?:ok(?:ay)?|sure|great|alright|done)[,.!]?\s+/i, '')
  h = h.replace(/^(?:so\s+)?(?:here(?:'|’)?s|here is|here are|these are|this is|below (?:is|are))\s+(?:(?:the|my|a|an|your|our|some)\s+)?/i, '')
  h = h.replace(/^(?:the|my|your|our)\s+/i, '').replace(/[.!]+$/, '').trim()
  if (h) return clip(h.charAt(0).toUpperCase() + h.slice(1), 60)
  const f = cleanListHeading(fallback)
  return f ? clip(f, 48) + ' checklist' : 'Checklist'
}

// The Stop hook's cheap check (no model): did this reply contain a list of 3+?
// -> { count, heading, kind, name, items } for the last such list, or null.
export function listHintFrom(text, { minItems = 3, maxItems = 60, fallback = null } = {}) {
  const ls = listsInText(text, { minItems })
  if (!ls.length) return null
  const c = ls[ls.length - 1]
  const items = c.items.slice(0, maxItems).map((x) => ({ text: clip(x.text, 300), done: !!x.done }))
  return { count: c.items.length, heading: c.heading || null, kind: c.kind, name: listAutoName(c, { fallback }), items, fp: listFingerprint(items) }
}

export function listSlug(s, max = 48) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'list'
}

const LIST_ORDER = ['name', 'repo', 'repo_key', 'source_session', 'source_machine', 'source_title', 'created', 'updated', 'archived', 'next_id', 'schema']
const LIST_ITEM = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*?)\s*(?:<!--\s*#(\d+)(?:\s+(\S+))?\s*-->)?\s*$/

// A list file -> { meta, items: [{ id, text, done, at }], body: [segments] }.
// body keeps every line that isn't an item (notes, blank lines) where it was,
// so a hand-edited file comes back out the same.
export function parseListMd(text) {
  const { data, body } = parseFrontmatter(text)
  const meta = {
    name: data.name == null ? null : String(data.name), repo: data.repo == null ? null : String(data.repo), repoKey: data.repo_key == null ? null : String(data.repo_key),
    sourceSession: data.source_session || null, sourceMachine: data.source_machine == null ? null : String(data.source_machine), sourceTitle: data.source_title == null ? null : String(data.source_title),
    created: data.created ? toIso(data.created) : null, updated: data.updated ? toIso(data.updated) : null, archived: data.archived === true, nextId: Number(data.next_id) || 0,
  }
  const items = [], segs = []
  let titleSeen = false
  for (const raw of String(body || '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')) {
    const m = raw.match(LIST_ITEM)
    if (m && !m[1]) {
      const it = { id: m[4] ? Number(m[4]) : null, text: m[3].trim(), done: m[2] !== ' ', at: m[5] ? toIso(m[5]) : null }
      items.push(it); segs.push({ item: it })
      continue
    }
    if (!titleSeen && /^#\s+/.test(raw)) { titleSeen = true; if (!meta.name) meta.name = raw.replace(/^#\s+/, '').trim(); segs.push({ title: true }); continue }
    segs.push({ line: raw })
  }
  return { meta, items, segs }
}

// Give every item a number (hand-added ones get the next free one).
export function numberListItems(list) {
  // nextId is the next number to give out; numbers are never reused
  let next = Math.max(list.meta.nextId || 1, ...list.items.map((x) => (x.id || 0) + 1))
  const seen = new Set()
  for (const it of list.items) {
    if (!it.id || seen.has(it.id)) it.id = next++
    seen.add(it.id)
  }
  list.meta.nextId = next
  return list
}

export function renderListMd(list) {
  numberListItems(list)
  const m = list.meta
  const fm = toFrontmatter({
    name: m.name || 'List', repo: m.repo || null, repo_key: m.repoKey || null, source_session: m.sourceSession || null, source_machine: m.sourceMachine || null,
    source_title: m.sourceTitle || null, created: m.created || null, updated: m.updated || null, archived: !!m.archived, next_id: m.nextId, schema: SCHEMA,
  }, LIST_ORDER)
  const segs = list.segs && list.segs.length ? list.segs.slice() : [{ title: true }, { line: '' }]
  // items not placed yet (new ones) go after the last item line
  const placed = new Set(segs.filter((s) => s.item).map((s) => s.item))
  const fresh = list.items.filter((it) => !placed.has(it))
  const live = new Set(list.items)
  let lastItem = -1
  segs.forEach((s, k) => { if (s.item) lastItem = k })
  const at = lastItem >= 0 ? lastItem + 1 : segs.length
  segs.splice(at, 0, ...fresh.map((it) => ({ item: it })))
  if (!segs.some((s) => s.title)) segs.unshift({ title: true }, { line: '' })
  const one = (s) => String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').replace(/<!--/g, '<!-').trim()
  const lines = []
  for (const s of segs) {
    if (s.title) lines.push('# ' + one(m.name || 'List'))
    else if (s.item) { if (live.has(s.item)) lines.push('- [' + (s.item.done ? 'x' : ' ') + '] ' + one(s.item.text) + ' <!-- #' + s.item.id + (s.item.at ? ' ' + s.item.at : '') + ' -->') }
    else lines.push(s.line)
  }
  return fm + lines.join('\n').replace(/\n+$/, '') + '\n'
}

export function newList({ name, items = [], repo = null, repoKey = null, sourceSession = null, sourceMachine = null, sourceTitle = null, now = new Date().toISOString() }) {
  const list = { meta: { name: cleanListHeading(name) || 'List', repo, repoKey, sourceSession, sourceMachine, sourceTitle, created: toIso(now), updated: toIso(now), archived: false, nextId: 0 }, items: [], segs: null }
  for (const it of items) if (it && String(it.text || '').trim()) list.items.push({ id: null, text: listItemText(it.text), done: !!it.done, at: it.done ? toIso(now) : null })
  return numberListItems(list)
}

// Two copies of one list (a sync conflict, or a hand edit racing the board):
// every item from either survives; for an item both have, the later change
// (its "at") wins; the name and archived flag come from the copy updated last.
export function mergeLists(a, b) {
  const newer = (ms(b.meta.updated) || 0) > (ms(a.meta.updated) || 0) ? b : a
  const older = newer === a ? b : a
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const out = { meta: { ...older.meta, ...newer.meta, nextId: Math.max(a.meta.nextId || 0, b.meta.nextId || 0) }, items: [], segs: newer.segs }
  const byId = new Map()
  const take = (it) => {
    let cur = it.id ? byId.get(it.id) : null
    // Same number, different words: an edit if they still look alike, else two
    // different items that each copy numbered on its own (both stay; one is renumbered).
    if (cur && norm(cur.text) !== norm(it.text) && !sameItemWords(cur.text, it.text)) cur = null
    if (!cur) cur = out.items.find((x) => norm(x.text) === norm(it.text))
    if (!cur) { const c = { ...it }; out.items.push(c); if (c.id && !byId.has(c.id)) byId.set(c.id, c); else if (c.id) c.id = null; return }
    if ((ms(it.at) || 0) > (ms(cur.at) || 0)) Object.assign(cur, { text: it.text, done: it.done, at: it.at })
  }
  for (const it of newer.items) take(it)
  for (const it of older.items) take(it)
  // newer's layout, with its own item objects swapped for the merged ones
  out.segs = (newer.segs || []).map((s) => (s.item ? { item: out.items.find((x) => x.id === s.item.id && x.id) || out.items.find((x) => norm(x.text) === norm(s.item.text)) || s.item } : s))
  const seen = new Set()
  out.segs = out.segs.filter((s) => !s.item || (!seen.has(s.item) && seen.add(s.item)))
  return numberListItems(out)
}

function sameItemWords(a, b) {
  const wa = new Set(String(a).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const wb = [...new Set(String(b).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))]
  if (!wa.size || !wb.length) return false
  return wb.filter((w) => wa.has(w)).length / Math.max(wa.size, wb.length) > 0.5
}

export function listProgress(list) {
  const total = list.items.length, done = list.items.filter((x) => x.done).length
  return { done, total, label: done + '/' + total }
}

// /cp-todo [name] [--pick [N]] and /cp-done <n…|text> [in <list>]
export function parseTodoArgs(args) {
  const s = String(args || '').trim()
  const m = s.match(/--pick(?:[=\s]+(\d+))?/)
  const rest = s.replace(/--pick(?:[=\s]+\d+)?/, '').trim()
  return { pick: m ? (m[1] ? Number(m[1]) : true) : null, name: rest || null }
}
export function parseDoneArgs(args) {
  const s = String(args || '').trim()
  const undo = /^(--undo|undo|not)\b/i.test(s)
  const body = s.replace(/^(--undo|undo|not)\s*/i, '')
  const inList = body.match(/\s+(?:in|from|on)\s+(\S+)\s*$/i)
  const main = inList ? body.slice(0, inList.index) : body
  const nums = main.split(/[\s,]+/).filter(Boolean)
  if (nums.length && nums.every((x) => /^#?\d+$/.test(x))) return { numbers: nums.map((x) => Number(x.replace('#', ''))), text: null, list: inList ? inList[1] : null, undo }
  return { numbers: [], text: main.trim() || null, list: inList ? inList[1] : null, undo }
}

// 0.8.6: /cp prints where this session's card opens (GET /v1/sessions/<id>/links).
export function boardLinkLines(l) {
  if (!l || !l.local) return []
  const out = ['Board: ' + l.local]
  if (l.relay) out.push('Phone: ' + l.relay)
  for (const u of l.tailnet || []) out.push('Tailnet: ' + u)
  return out
}

// 0.8.6: runs nobody sits in front of: `claude -p` / the Agent SDK
// (CLAUDE_CODE_ENTRYPOINT sdk-*, or a mod session with no surface) and
// `codex exec`. They aren't your work sessions, so the board leaves them out.
export function isNonInteractive({ surface = null, entrypoint = null } = {}) {
  const e = String(entrypoint || '').toLowerCase()
  if (/^sdk/.test(e) || e === 'print' || e === 'headless') return true
  return surface === 'headless' || surface === 'codex-exec'
}

// 0.9.9: a session Leftoff itself started from the board (src/headless.js).
// It runs as `claude -p` (entrypoint sdk-cli) but it is your work: the daemon
// spawned it with LEFTOFF_HEADLESS=<its session id>. Anything else in that
// variable (empty, a stray value) doesn't count.
export function isLeftoffHeadless(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim())
}

// Our own summarizer's and titler's prompts (buildCheckpointPrompt, TITLE
// prompt): a session that starts with one is Leftoff talking to a model.
export function isOwnSummarizerPrompt(p) {
  const t = String(p || '')
  return /^First prompt:\n/.test(t) || /^Repo: .* · cwd .*\nTitle: .*\nPrevious checkpoint: /.test(t)
}
