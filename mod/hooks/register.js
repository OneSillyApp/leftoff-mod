// Leftoff mod (Leftoff was called Checkpoints before v0.4.5): the Claude Code
// side of the Leftoff system.
//
// It posts session lifecycle and activity to the local daemon
// (http://127.0.0.1:7429), builds checkpoints with $.model.complete when the
// daemon says one is due, adds /cp, /cp-name, /cp-park and /leftoff (and /checkpoints, its old name), and draws
// a pane listing every open session. When the daemon is down it spools events
// to ~/checkpoints/.spool, keeps a session record in $.store, tracks idle
// itself and writes checkpoint markdown straight into the folder.
//
// Static-analysis rules this file follows (claude plugin validate): every mods
// API call is written in full ($.ns.method), $ is only passed to functions
// declared at the top level of this file, event names are string literals, and
// each event is registered once per matcher.
import {
  DEFAULT_CONFIG, DEFAULT_PORT, mergeConfig, resolveMachine, applyEvent, checkpointDue, buildCheckpointPrompt,
  parseCheckpointReply, retryCheckpointPrompt, betterSalvage, heuristicCheckpoint, isEmptyCheckpoint, NOTHING_TO_CHECKPOINT, renderCheckpointMd, checkpointId, checkpointFileName,
  sessionFolderName, id8, clip, toIso, resumeCommand, repoName,
  shortId, formatTabTitle, parseTabTitle, tabRenameWaits, detectTerminal, parseProcLine, trailingQuestion,
  parseCheckpointArgs, SUMMARY_LENGTHS, parseBulletList, parseCatchupArgs,
  listHintFrom, backgroundListFrom, extractChecklists, parseTodoArgs, parseDoneArgs, detectBackend, parseParkArgs,
  boardLinkLines, isNonInteractive, isLeftoffHeadless, lockForPark, parkLockHeld, unlockParkLocks, parkWorktreeText,
} from './core.js'

const PANE_ID = 'checkpoints'
const POST_TIMEOUT_MS = 800
const END_TIMEOUT_MS = 1000
const MODEL_TIMEOUT_MS = 20000

// Module state. $.state is not used: the pane redraws with $.ui.invalidate.
const MOD_VERSION = '0.9.16' // keep in step with .claude-plugin/plugin.json

const st = {
  internal: false,
  headless: false, // 0.9.9: started from the board (LEFTOFF_HEADLESS)
  ready: false,
  sessionId: null,
  root: null,
  token: null,
  port: DEFAULT_PORT,
  cfg: DEFAULT_CONFIG,
  record: null, // local mirror of the daemon's session record, kept with the shared applyEvent
  daemonUp: null,
  heartbeat: null,
  paneTimer: null,
  paneRows: [],
  paneNote: '',
  checkpointing: false,
  lastCheckpoint: null,
  clearedFrom: null, // 0.9.15: the last checkpoint before a /clear in this process
  nameCommand: 'cp-name',
  commands: null,
  modHealthSent: false,
  machine: 'unknown',
  proc: null, // { pid, tty, pidStartedAt } of this Claude Code process
  term: null, // detectTerminal() of this session's environment
  titleOff: false, // CLAUDE_CODE_DISABLE_TERMINAL_TITLE: Claude Code draws no title, so the mod writes OSC 2 itself
  tabTitle: null, // the tab title last applied
  tabMarker: false, // v0.5.5: the daemon says Go needs "cp:<id>" in this tab's title
  tabMarkerKept: false, // 0.9.9: once this session's tab carried the marker, it keeps it (no flip back)
  lastRename: null, // 0.9.9: { id, title, at } of the last /rename the mod ran by itself
  paneSel: 0,
  paneRepo: null, // the pane's repo filter (f)
  paneAll: [],
  hello: null, // what session.opened said (folder, repo, model, surface, process, terminal), to say again when asked
  helloAt: 0,
  asks: {}, // board requests this session has open: id -> { tool, input, done }
  replyLoop: false, // the long-poll for board replies is running
  listSig: null, // v0.5.1: the signature of this session's lists Claude last heard about
  listPending: false, // a list was saved or ticked here: tell Claude with the next prompt
  paneNeeds: 0, // sessions that need you (the pane's top line)
}

// Millisecond precision: the daemon dedupes events per (sessionId, type, at).
function nowIso() { return new Date().toISOString() }

function rand() {
  const a = new Uint32Array(1)
  crypto.getRandomValues(a)
  return a[0].toString(16).padStart(8, '0')
}

function raceTimeout(promise, msec, $) {
  return Promise.race([
    promise,
    new Promise((resolve) => { $.clock.after(msec, () => resolve({ timedOut: true })) }),
  ])
}

async function api($, method, path, body, timeoutMs) {
  const url = 'http://127.0.0.1:' + st.port + path
  const init = { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (st.token || '') } }
  if (body !== undefined) init.body = JSON.stringify(body)
  try {
    const r = await raceTimeout($.http.fetch(url, init), timeoutMs || POST_TIMEOUT_MS, $)
    if (r.timedOut) { st.daemonUp = false; return null }
    st.daemonUp = r.status !== 401 && r.status < 500
    let json = null
    try { json = JSON.parse(r.text) } catch {}
    return { status: r.status, ok: r.ok, json }
  } catch {
    st.daemonUp = false
    return null
  }
}

// Every event goes through here: post, or spool a unique file (fs.write isn't atomic).
async function sendOrSpool($, type, data, timeoutMs) {
  if (st.internal || !st.sessionId) return null
  if (await internalOnce($)) return null // a hook that fires before session.start has read the env (see internalOnce)
  try { await ensureSetup($) } catch {} // a setup that failed leaves the fallback below to name the spool file's folder
  const ev = { v: 1, type, sessionId: st.sessionId, at: nowIso(), capture: 'mod', machine: st.machine, data: data || {} }
  st.record = applyEvent(st.record || { id: st.sessionId, turns: 0, turnsSinceCheckpoint: 0, backgroundTasks: 0 }, ev)
  const r = await api($, 'POST', '/v1/events', { events: [ev] }, timeoutMs)
  if (r && r.ok) {
    const j = r.json || {}
    if (j.session && j.session.id === st.sessionId && j.session.title) st.daemonTitle = j.session.title
    // v0.5.5: the daemon says when Go needs the "cp:<id>" marker in this tab's title
    if (j.session && j.session.id === st.sessionId && typeof j.session.tabMarker === 'boolean') st.tabMarker = j.session.tabMarker
    if (j.hello && type !== 'session.opened' && type !== 'session.ended') await sayHelloAgain($)
    return j
  }
  try {
    // An absolute root even when setup never came: without one the concat
    // makes st.root null a relative "null/.spool" beside the session's cwd.
    let root = st.root
    if (!root) {
      const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
      if (home) root = home.replace(/[\\/]+$/, '') + '/checkpoints' // never a bare "/checkpoints"
    }
    // Only an absolute folder; otherwise skip the file but still keep the registry below.
    if (root && /^([A-Za-z]:[\\/]|\/)/.test(String(root))) {
      await $.fs.write(String(root) + '/.spool/' + (st.machine || 'unknown') + '/' + st.sessionId + '/' + Date.now() + '-' + rand() + '.json', JSON.stringify({ events: [ev] }) + '\n')
    }
  } catch {}
  try {
    await $.store.set('session:' + st.sessionId, {
      id: st.sessionId, title: st.record.title || null, cwd: st.record.cwd || null, repo: st.record.repo || null,
      lastActivityAt: st.record.lastActivityAt || null, lastHeartbeatAt: nowIso(), endedAt: st.record.endedAt || null,
      next: st.lastCheckpoint ? st.lastCheckpoint.next : null,
    })
  } catch {}
  return null
}

// v0.4.8: the daemon restarted since this session said hello (a restart used
// to forget a session that had no turns yet), so it doesn't know this
// session's folder, process or terminal. Say it again (at most every 5 minutes).
async function sayHelloAgain($) {
  if (!st.hello || Date.now() - st.helloAt < 300000) return
  st.helloAt = Date.now()
  await sendOrSpool($, 'session.opened', { ...st.hello, again: true })
}

// Read once per process and shared: the classic hooks (SessionStart, Stop …)
// can fire while session.start is still awaiting the env, and used to send
// before st.internal was set, so our own claude -p runs (the summarizer's,
// Ask's) reached the daemon as sessions (it then archived them as
// non-interactive). Every send now waits for the same answer.
let internalP = null
function internalOnce($) {
  if (!internalP) internalP = isInternal($).then((v) => { if (v) st.internal = true; return !!v }, () => false)
  return internalP
}

async function isInternal($) {
  // Leftoff's own claude runs (the summarizer's claude -p, claude plugin …) carry this.
  if ((await $.env.get('LEFTOFF_INTERNAL')) || (await $.env.get('CHECKPOINTS_INTERNAL'))) return true
  // Ask about a project's own read-only claude -p run: never a session, whatever else is set
  if (await $.env.get('LEFTOFF_ASK')) return true
  // 0.9.9: a session Leftoff started from the board runs as claude -p, but it is yours.
  if (await isHeadless($)) return false
  // 0.8.6: `claude -p` / the Agent SDK (CLAUDE_CODE_ENTRYPOINT sdk-*): not a work session.
  try { return isNonInteractive({ entrypoint: await $.env.get('CLAUDE_CODE_ENTRYPOINT') }) } catch { return false }
}

// 0.9.9: started by Leftoff from the board (src/headless.js): no terminal, no
// tab to name, the daemon writes the board's messages on its stdin and answers
// its permission prompts itself, so the mod only reports.
async function isHeadless($) {
  try { return isLeftoffHeadless(await $.env.get('LEFTOFF_HEADLESS')) } catch { return false }
}

async function loadSetup($) {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  st.root = ((await $.env.get('LEFTOFF_DIR')) || (await $.env.get('CHECKPOINTS_DIR')) || home + '/checkpoints').replace(/\/+$/, '')
  try { st.token = String(await $.fs.read(st.root + '/.secret/token')).trim() } catch { st.token = null }
  try {
    st.cfg = mergeConfig(DEFAULT_CONFIG, JSON.parse(String(await $.fs.read(st.root + '/config.json'))))
    st.port = Number(st.cfg.port) || DEFAULT_PORT
  } catch { st.cfg = DEFAULT_CONFIG }
  const port = await $.env.get('CHECKPOINTS_PORT')
  if (port) st.port = Number(port)
  // Same rule as the daemon: CHECKPOINTS_MACHINE > config machineNames[hostname] > config machine > hostname
  let hostname = ''
  try { const r = await $.process.run(['hostname']); if (r.exitCode === 0) hostname = String(r.stdout || '').trim() } catch {}
  if (!hostname) hostname = (await $.env.get('HOSTNAME')) || (await $.env.get('COMPUTERNAME')) || ''
  st.machine = resolveMachine({ env: await $.env.get('CHECKPOINTS_MACHINE'), hostname, cfg: st.cfg })
}

// loadSetup runs once per process and every sender awaits the same attempt:
// a hook that fires before session.start (classic.SessionStart on a cold
// boot, the old null/.spool race) waits for these values instead of reading
// st at its initial state.
let setupPromise = null
function ensureSetup($) {
  if (!setupPromise) {
    const p = loadSetup($)
    setupPromise = p
    p.catch(() => { if (setupPromise === p) setupPromise = null }) // a failed setup tries again on the next event
  }
  return setupPromise
}

async function readRepo($, cwd) {
  let repo = null
  try {
    const r = await $.session.repo()
    if (r) repo = { root: r.root, name: r.root ? r.root.split('/').filter(Boolean).pop() : r.name }
  } catch {}
  if (repo) {
    try {
      const out = await $.process.run(['git', '-C', cwd, 'symbolic-ref', '--short', '-q', 'HEAD'])
      const b = String(out.stdout || '').trim()
      if (out.exitCode === 0 && b) repo.branch = b // empty on a detached HEAD
    } catch {}
  }
  return repo
}

async function heartbeat($) {
  if (st.internal || !st.sessionId) return
  const res = await sendOrSpool($, 'heartbeat', { inTurn: !!(st.record && st.record.inTurn) })
  if (res && !st.modHealthSent) await reportModHealth($)
  if (res && st.daemonTitle) await noteTitle($, st.daemonTitle)
  else if (res && st.tabTitle && !(st.record && st.record.inTurn)) await applyTabTitle($, null) // the marker came (it never goes: tabMarkerKept), or a rename that had to wait
  if (res && res.checkpointDue && res.checkpointDue.sessionId === st.sessionId) {
    await makeCheckpoint($, res.checkpointDue.reason, null)
  } else if (!res && st.record) {
    // Daemon down: the same dormancy rules, run locally.
    const reason = checkpointDue(st.record, Date.now(), st.cfg)
    if (reason) await makeCheckpoint($, reason, null)
  }
}

// The commands, in the order they're tried. Claude Code 2.1.295's built-ins
// own /checkpoint (an alias of /rewind) and /name (an alias of /rename), so
// ours share a /cp prefix; each command lists fallbacks in case a later
// release takes a name. -> st.commands: [{ key, want, name, ok, error }]
const COMMANDS = [
  { key: 'checkpoint', names: ['cp', 'cp-save'], description: 'Leftoff: save a checkpoint of this session now (--short / --long for this one)', argumentHint: '[--short|--long] [note]', immediate: true },
  { key: 'name', names: ['cp-name'], description: 'Leftoff: name this session (runs /rename, tells the board); --auto names it from the latest messages', argumentHint: '<title> | --auto', immediate: false },
  { key: 'pane', names: ['leftoff'], description: 'Leftoff: every open session and its status (/leftoff open: the board)', argumentHint: '[open]', immediate: true },
  // The pane's pre-0.4.5 name, kept so the habit keeps working.
  { key: 'pane-old', names: ['checkpoints'], description: 'Leftoff (old name): same as /leftoff', argumentHint: '[open]', immediate: true },
  // v0.5.0: one recap across your sessions; same as `leftoff catchup`.
  { key: 'catchup', names: ['cp-catchup', 'leftoff-catchup'], description: 'Leftoff: catch me up — what got done, where each session stopped, what\'s waiting on you', argumentHint: '[24h|3d|workday|friday] [repo…|here|all]', immediate: true },
  // v0.5.1: save the checklist Claude just wrote; tick its items.
  { key: 'todo', names: ['cp-todo', 'leftoff-todo'], description: 'Leftoff: save the checklist Claude just wrote as a list you can tick off (board, phone, or here)', argumentHint: '[name] [--pick [N]]', immediate: true },
  // v0.8.2: checkpoint, mark the session Parked (not Closed when it exits), then close it.
  { key: 'park', names: ['cp-park', 'leftoff-park'], description: 'Leftoff: checkpoint and park this session to come back to (your note becomes the Next line), then exit', argumentHint: '[note]', immediate: false },
  { key: 'done', names: ['cp-done', 'leftoff-done'], description: 'Leftoff: tick items on this session\'s list (/cp-done 3, /cp-done 2 4, /cp-done undo 3)', argumentHint: '<n…> [in <list>]', immediate: true },
]

async function registerCommands($) {
  const results = []
  for (const c of COMMANDS) {
    const r = { key: c.key, want: c.names[0], name: null, ok: false, error: null, tried: [] }
    for (const name of c.names) {
      r.tried.push(name)
      try {
        await $.command.register({ name, description: c.description, argumentHint: c.argumentHint, immediate: c.immediate })
        r.name = name
        r.ok = true
        r.error = null
        break
      } catch (err) {
        r.error = String((err && err.message) || err).slice(0, 200)
      }
    }
    results.push(r)
  }
  st.commands = results
  if (results.some((x) => x.key === 'name' && x.ok)) st.nameCommand = results.find((x) => x.key === 'name').name
  const failed = results.filter((x) => !x.ok)
  const moved = results.filter((x) => x.ok && x.name !== x.want)
  try {
    if (failed.length) $.ui.log('commands failed to register: ' + failed.map((x) => '/' + x.want + ' (' + x.error + ')').join('; '))
    if (moved.length) $.ui.log('using ' + moved.map((x) => '/' + x.name + ' instead of /' + x.want).join(', '))
  } catch {}
  st.modHealthSent = false
  await reportModHealth($)
  return results
}

// Tell the daemon which commands this session got, so `leftoff doctor`
// and the board can show a failed registration. Best effort: if the daemon is
// down, the heartbeat tries again.
async function reportModHealth($) {
  if (st.modHealthSent || !st.commands || !st.sessionId) return
  const body = { sessionId: st.sessionId, machine: st.machine, modVersion: MOD_VERSION, at: nowIso(), commands: st.commands.map((c) => ({ key: c.key, want: c.want, name: c.name, ok: c.ok, error: c.error })) }
  const r = await api($, 'POST', '/v1/mod/health', body, 1500)
  if (r && r.ok) st.modHealthSent = true
}

// /cp [--short|--long] [note]: the flag picks the length for this one checkpoint.
async function checkpointCommand($, args) {
  const a = parseCheckpointArgs(args)
  const cp = await makeCheckpoint($, 'manual', a.note, a.length)
  const links = await boardLinks($)
  if (!cp) return { text: ['Leftoff: a checkpoint is already being made.', ...links].join('\n') }
  return links.length ? { text: links.join('\n') } : {}
}

// 0.8.6: this session's card on the board, here and (when they're on) from
// your phone (relay, tailnet); the daemon knows those. boardLinkLines: core.js.
async function boardLinks($) {
  if (st.internal || !st.sessionId) return []
  const r = await api($, 'GET', '/v1/sessions/' + encodeURIComponent(st.sessionId) + '/links', undefined, 800)
  if (r && r.ok && r.json) return boardLinkLines(r.json)
  return boardLinkLines({ local: 'http://127.0.0.1:' + (st.port || 7429) + '/#/s/' + encodeURIComponent(st.sessionId) })
}

// ------------------------------------------------------------ park (v0.8.2)

// /cp-park [note]: a checkpoint now (the note, if any, is its Next line, else
// the usual summary), then the session is marked Parked, so it stays on the
// board under Parked instead of going to Closed when Claude Code exits. Then
// it runs the built-in /exit for you (registered with immediate: false, so it
// only runs once Claude is done with the turn). If that's refused, it says to
// type /exit. Nothing is ever killed.
const PARK_FALLBACK = 'Parked. Type /exit when you\'re ready, and it\'ll stay on your board.'
const PARK_LOCK_LOST = 'Parked, but not closed: the worktree lock Leftoff took is gone, and on /exit Claude Code removes a worktree that has no changes. Lock it again (git worktree lock), or choose Keep if Claude Code asks.'
// 0.8.8: argv -> { exitCode, stdout, stderr } for the worktree helpers in core.js
async function gitFor($, argv) { return $.process.run(argv, { timeoutMs: 5000 }) }
async function parkCommand($, args) {
  if (st.internal || !st.sessionId) return { text: 'Leftoff: not in a tracked session.' }
  const a = parseParkArgs(args)
  // 0.8.8: in a git worktree, lock it first: Claude Code's exit removes a worktree
  // with no changes, and parking means coming back. No lock, no automatic /exit.
  let cwd = null
  try { cwd = await $.session.cwd() } catch {}
  cwd = cwd || (st.record && st.record.cwd) || null
  const run = (argv) => gitFor($, argv)
  const wt = cwd ? await lockForPark(run, cwd, st.sessionId).catch((e) => ({ worktree: null, locked: false, unsure: true, why: String(e && e.message) })) : { worktree: null, locked: false, unsure: true, why: 'no folder on record' }
  const cp = await makeCheckpoint($, 'park', a.note, null, { next: a.note })
  if (!cp) {
    if (wt.locked) await unlockParkLocks(run, wt.root || wt.worktree, st.sessionId).catch(() => null) // not parked after all
    return { text: 'Leftoff: a checkpoint is already being made. Try /cp-park again in a moment.' }
  }
  const worktreeLock = wt.locked ? { path: wt.worktree, root: wt.root || null, reason: wt.reason } : null
  await sendOrSpool($, 'session.parked', { note: a.note, checkpoint: cp.id || null, by: 'command', ...(worktreeLock ? { worktreeLock } : {}) })
  const head = 'Parked' + (a.note ? ': ' + clip(a.note, 120) : '') + '.'
  if (wt.worktree || wt.unsure) {
    if (!wt.locked) return { text: head + parkWorktreeText(wt) }
  }
  // After this command returns, not inside it: the built-in /exit (in a worktree, only while our lock still holds).
  $.clock.after(400, async () => {
    if (worktreeLock && !(await parkLockHeld(run, worktreeLock.path, worktreeLock.reason))) { try { $.ui.toast(PARK_LOCK_LOST, { timeoutMs: 12000 }) } catch {} return }
    try { await $.command.run({ command: 'exit' }) } catch { try { $.ui.toast(PARK_FALLBACK, { timeoutMs: 8000 }) } catch {} }
  })
  return { text: head + ' Closing this session; it stays on your board under Parked.' + parkWorktreeText(wt) }
}

// 0.8.8: this session is back (claude --resume, or --worktree <name> --resume):
// unlock any worktree Leftoff locked when it was parked. Only its own lock.
async function unlockOwnParkLocks($, cwd) {
  if (st.internal || !st.sessionId || !cwd) return
  try {
    await unlockParkLocks((argv) => gitFor($, argv), cwd, st.sessionId)
  } catch {}
}

// ------------------------------------------------------------ lists (v0.5.1)

// This session's saved lists, when they changed since Claude last heard
// (the daemon's signature moved) -> the context text, else null. One local
// GET per prompt; the daemon reads the lists from a 2-second cache.
async function listContextFor($) {
  if (st.internal || !st.sessionId || st.daemonUp === false && !st.listPending) return null
  const r = await api($, 'GET', '/v1/sessions/' + encodeURIComponent(st.sessionId) + '/lists', undefined, 600)
  if (!r || !r.ok || !r.json) return null
  const sig = r.json.signature || null
  if (!sig || (sig === st.listSig && !st.listPending)) { st.listPending = false; return null }
  st.listSig = sig
  st.listPending = false
  return r.json.context || null
}

function listLines(l, max = 30) {
  const out = []
  for (const it of (l.items || []).slice(0, max)) out.push('  ' + String(it.n).padStart(2) + ' ' + (it.done ? '[x]' : '[ ]') + ' ' + clip(it.text, 110))
  if ((l.items || []).length > max) out.push('  … ' + ((l.items || []).length - max) + ' more')
  return out
}

// /cp-todo [name] [--pick [N]]: save the most recent checklist Claude wrote
// in this session (or the one picked) as a list in the folder.
async function saveTodo($, args) {
  if (st.internal || !st.sessionId) return { text: 'Leftoff: not in a tracked session.' }
  const a = parseTodoArgs(args)
  let messages = []
  try { messages = await $.session.messages() } catch {}
  const found = extractChecklists(messages, { minItems: 2, fallback: st.daemonTitle || (st.record && st.record.title) || null }).reverse()
  if (!found.length) return { text: 'Leftoff: no checklist from Claude in this session yet. Ask for one ("list the next steps to …"); Leftoff picks up "- [ ]" checklists and numbered or bulleted lists under a heading like "Next steps".' }
  if (a.pick === true) {
    const lines = ['Checklists Claude wrote in this session (newest first):', '']
    for (let k = 0; k < found.length && k < 12; k++) {
      const c = found[k]
      lines.push('  ' + (k + 1) + '. ' + c.name + ' · ' + c.items.length + ' items')
      for (const it of c.items.slice(0, 2)) lines.push('       ' + clip(it.text, 90))
    }
    lines.push('', 'Save one: /cp-todo --pick <n> [name]')
    return { text: lines.join('\n') }
  }
  const c = typeof a.pick === 'number' ? found[a.pick - 1] : found[0]
  if (!c) return { text: 'Leftoff: there\'s no list ' + a.pick + ' (/cp-todo --pick shows them).' }
  const r = await api($, 'POST', '/v1/lists', { sessionId: st.sessionId, items: c.items, name: a.name || c.name }, 5000)
  if (!r) return { text: 'Leftoff: the daemon isn\'t running, so the list wasn\'t saved. Start it with `leftoff serve`, or save it from a terminal: leftoff todo capture ' + st.sessionId + (a.name ? ' --name ' + JSON.stringify(a.name) : '') }
  if (!r.ok || !r.json || !r.json.list) return { text: 'Leftoff: couldn\'t save the list' + (r.json && r.json.error ? ': ' + r.json.error.message : ' (' + r.status + ')') }
  const l = r.json.list
  st.listPending = true // Claude hears about it with the next prompt
  return { text: ['Saved "' + l.name + '" (' + l.total + ' items) → lists/' + l.ref + '.md', ...listLines(l), '',
    'Tick items: /cp-done 3 · or just tell Claude "step 3 is done" (it runs `leftoff todo done ' + l.ref + ' 3`) · or tick them on the board / phone under Lists.'].join('\n') }
}

// /cp-done <n…|words> [in <list>], /cp-done undo <n>
async function tickTodo($, args) {
  if (st.internal || !st.sessionId) return { text: 'Leftoff: not in a tracked session.' }
  const a = parseDoneArgs(args)
  if (!a.numbers.length && !a.text) return { text: 'Usage: /cp-done <n> [<n>…] [in <list>]  ·  /cp-done undo <n>' }
  let ref = a.list
  if (!ref) {
    const r = await api($, 'GET', '/v1/sessions/' + encodeURIComponent(st.sessionId) + '/lists', undefined, 3000)
    if (!r) return { text: 'Leftoff: the daemon isn\'t running. From a terminal: leftoff todo done <list> ' + (a.numbers.join(' ') || a.text) }
    const open = ((r.json && r.json.lists) || []).filter((l) => !l.archived)
    if (!open.length) return { text: 'Leftoff: no list saved from this session yet. /cp-todo saves the checklist Claude just wrote; for another list: /cp-done 3 in <list>.' }
    ref = open[0].ref // the newest one
  }
  const body = a.numbers.length ? { [a.undo ? 'undone' : 'done']: a.numbers } : { text: a.text, undo: a.undo }
  const r = await api($, 'POST', '/v1/lists/' + encodeURIComponent(ref).replace('%2F', '/') + '/change', body, 4000)
  if (!r) return { text: 'Leftoff: the daemon isn\'t running. From a terminal: leftoff todo done ' + ref + ' ' + (a.numbers.join(' ') || a.text) }
  if (!r.ok || !r.json || !r.json.list) {
    // a list named in the command: let the daemon resolve names, not just ids
    if (a.list && r.status === 404) {
      const res = await api($, 'GET', '/v1/lists/resolve?ref=' + encodeURIComponent(a.list), undefined, 3000)
      if (res && res.ok && res.json && res.json.list && res.json.list.ref !== ref) return tickTodo($, (a.undo ? 'undo ' : '') + (a.numbers.join(' ') || a.text) + ' in ' + res.json.list.ref)
    }
    return { text: 'Leftoff: ' + ((r.json && r.json.error && r.json.error.message) || 'couldn\'t change the list (' + r.status + ')') }
  }
  const l = r.json.list
  st.listPending = true
  const hit = a.numbers.length ? l.items.filter((x) => a.numbers.includes(x.n)) : []
  const line = (a.undo ? '↺ ' : '✓ ') + (hit.length ? hit.map((x) => '#' + x.n + ' ' + clip(x.text, 80)).join('; ') : 'ticked') + (a.undo ? ' (unticked)' : '') + ' · ' + l.name + ' ' + l.progress
  const missing = r.json.missing && r.json.missing.length ? '\n(no item ' + r.json.missing.join(', ') + ' on that list)' : ''
  return { text: line + missing + (l.done === l.total ? '\nThat\'s the whole list. 🎉' : '') }
}

// /cp-catchup [window] [repo ...|here|all] (v0.5.0): the daemon reads the
// folder and assembles the recap; with an in-session provider (auto, claude,
// anthropic) this session's own model writes the summary on top, otherwise the
// daemon's summarizer (or its no-model summary) does. Saved to catchups/ like
// the board's and the CLI's. -> { text } shown in the session.
async function makeCatchup($, args) {
  if (st.internal) return { text: 'Leftoff: not in an internal session.' }
  const a = parseCatchupArgs(args)
  const repos = a.here ? [((st.record && st.record.repo && st.record.repo.root) || (st.record && st.record.cwd) || '')].filter(Boolean) : a.repos
  const req = { since: a.since || undefined, repos }
  const prep = await api($, 'POST', '/v1/catchups/prepare', req, 15000)
  if (!prep) return { text: 'Leftoff: the daemon isn\'t running, so there\'s nothing to read. Start it with `leftoff serve` (or run `leftoff catchup` in a terminal; it reads the folder directly).' }
  if (!prep.ok) return { text: 'Leftoff: ' + ((prep.json && prep.json.error && prep.json.error.message) || 'catch-up failed (' + prep.status + ')') }
  const p = prep.json || {}
  let summary
  if (p.prompt) {
    const r = await callModel($, p.prompt)
    const bullets = r && parseBulletList(r.text, 6)
    if (bullets) summary = { bullets, provider: 'claude-in-session', model: r.model || null }
  }
  const made = await api($, 'POST', '/v1/catchups', { ...req, to: p.window && p.window.to, summary }, summary ? 15000 : 90000)
  if (!made || !made.ok) return { text: 'Leftoff: catch-up failed' + (made && made.json && made.json.error ? ': ' + made.json.error.message : '') }
  return { text: formatCatchupText(made.json) }
}

function formatCatchupText(c) {
  const r = c.recap || {}, w = r.window || {}
  const lines = ['Catch me up · ' + (w.label || '') + ' · ' + (r.sessions || []).length + ' session' + ((r.sessions || []).length === 1 ? '' : 's') + ' in ' + (r.repos || []).length + ' repo' + ((r.repos || []).length === 1 ? '' : 's'), '']
  for (const b of (c.summary && c.summary.bullets) || []) lines.push('• ' + b)
  const needs = r.needsYou || []
  if (needs.length) { lines.push('', 'Needs you:'); for (const n of needs.slice(0, 6)) lines.push('  ! ' + n.title + ' (' + n.repo + ') — ' + clip(n.needsYou, 140)) }
  const rest = (r.sessions || []).filter((x) => !x.needsYou).slice(0, 8)
  if (rest.length) { lines.push('', 'Where each one stopped:'); for (const x of rest) lines.push('  · ' + x.title + ' (' + x.repo + ', ' + x.state + ')' + (x.next ? ' — Next: ' + clip(x.next, 120) : '')) }
  const open = r.stillOpen || []
  if (open.length) { lines.push('', 'Still open:'); for (const l of open.slice(0, 6)) lines.push('  ☐ ' + l.name + ' (' + l.repo + ', ' + l.done + '/' + l.total + ')' + (l.next && l.next[0] ? ' — next: #' + l.next[0].n + ' ' + clip(l.next[0].text, 100) : '')) }
  if (c.path) lines.push('', 'Saved ' + c.path + ' · the full page: /leftoff open → Catch me up')
  return lines.join('\n')
}

// Run the CLI: `leftoff`, or `checkpoints` (its pre-0.4.5 name, still installed
// as an alias) when `leftoff` isn't on PATH yet. -> the run result, or null.
async function runCli($, args, opts) {
  for (const bin of ['leftoff', 'checkpoints']) {
    try {
      const r = opts ? await $.process.run([bin, ...args], opts) : await $.process.run([bin, ...args])
      if (r && r.exitCode !== 127) return r
    } catch {}
  }
  return null
}

// Open the web board. `leftoff open --print` knows the token, starts the
// daemon if it's down and picks leftoff.localhost or 127.0.0.1; then the OS
// opener (macOS `open`, Linux `xdg-open`) shows it. Without the CLI on PATH it
// opens the 127.0.0.1 URL. The URL is always toasted too, so it can be clicked
// or copied when no browser opens (SSH, containers).
// /leftoff (and /checkpoints): the pane, or `open` for the web board.
async function paneCommand($, args) {
  if (/^\s*(open|board|ui)\s*$/i.test(String(args || ''))) { const url = await openBoard($); return { text: 'Board: ' + url } }
  if (st.paneTimer) { st.paneTimer.cancel(); st.paneTimer = null }
  await refreshPane($)
  let surfaces = []
  try { surfaces = await $.session.surfaces() } catch {}
  if (!surfaces || !surfaces.length) return { text: textList() } // VS Code extension and -p: no panes
  await $.ui.open({ id: PANE_ID, title: 'Leftoff', closeOnEscape: true })
  if (st.paneTimer) st.paneTimer.cancel()
  st.paneTimer = $.clock.every(15000, () => { refreshPane($).catch(() => {}) })
  return {}
}

async function openBoard($) {
  let url = 'http://127.0.0.1:' + st.port + '/'
  try {
    const r = await runCli($, ['open', '--print'])
    const u = String((r && r.stdout) || '').trim().split('\n').pop()
    if (r && r.exitCode === 0 && /^http:\/\/[\w.[\]:-]+\/$/.test(u)) url = u
  } catch {}
  let opened = false
  for (const opener of ['open', 'xdg-open']) {
    try { const r = await $.process.run([opener, url]); if (r && r.exitCode === 0) { opened = true; break } } catch {}
  }
  $.ui.toast((opened ? 'Opened ' : 'Board: ') + url, { timeoutMs: 10000 })
  return url
}

// ---------------------------------------------------------------- where this session runs (v0.4)

// One shell call: our parent is Claude Code's process (checked on 2.1.295:
// $.process.run's child has Claude Code as its direct parent). If a wrapper
// sits between, walk up to the first process named like claude.
const PROC_SCRIPT = 'p=$PPID; i=0; while [ "$i" -lt 4 ]; do c=$(LC_ALL=C ps -o comm= -p "$p" 2>/dev/null); case "$c" in *claude*|*Claude*) break;; esac; q=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " "); [ -z "$q" ] || [ "$q" -le 1 ] && { p=$PPID; break; }; p=$q; i=$((i+1)); done; [ "$i" -ge 4 ] && p=$PPID; set -- $(LC_ALL=C ps -o tty=,etime= -p "$p" 2>/dev/null); echo "$p ${1:-?} ${2:-}"'

async function probeProcess($) {
  try {
    const r = await $.process.run(['sh', '-c', PROC_SCRIPT], { timeoutMs: 3000 })
    if (r && r.exitCode === 0) return parseProcLine(String(r.stdout || '').trim().split('\n').pop(), Date.now())
  } catch {}
  return null
}

// $.env.get takes literal names only (static analysis lists what a mod reads).
async function readTermEnv($) {
  const env = {}
  const put = (k, v) => { if (v) env[k] = String(v) }
  try {
    put('TERM_PROGRAM', await $.env.get('TERM_PROGRAM'))
    put('TERM_PROGRAM_VERSION', await $.env.get('TERM_PROGRAM_VERSION'))
    put('TERM', await $.env.get('TERM'))
    put('GHOSTTY_RESOURCES_DIR', await $.env.get('GHOSTTY_RESOURCES_DIR'))
    put('ITERM_SESSION_ID', await $.env.get('ITERM_SESSION_ID'))
    put('WEZTERM_PANE', await $.env.get('WEZTERM_PANE'))
    put('WEZTERM_UNIX_SOCKET', await $.env.get('WEZTERM_UNIX_SOCKET'))
    put('KITTY_WINDOW_ID', await $.env.get('KITTY_WINDOW_ID'))
    put('KITTY_LISTEN_ON', await $.env.get('KITTY_LISTEN_ON'))
    put('TMUX', await $.env.get('TMUX'))
    put('TMUX_PANE', await $.env.get('TMUX_PANE'))
    put('TERM_SESSION_ID', await $.env.get('TERM_SESSION_ID'))
    st.titleOff = !!(await $.env.get('CLAUDE_CODE_DISABLE_TERMINAL_TITLE'))
  } catch {}
  return env
}

// 0.6.8: is this Claude Code talking to Ollama or another server? (literal
// names only). The auth token is only compared with "ollama" and never kept.
async function readBackend($, model) {
  try {
    const env = {}
    const put = (k, v) => { if (v) env[k] = String(v) }
    put('ANTHROPIC_BASE_URL', await $.env.get('ANTHROPIC_BASE_URL'))
    if (!env.ANTHROPIC_BASE_URL) return null
    if ((await $.env.get('ANTHROPIC_AUTH_TOKEN')) === 'ollama') env.ANTHROPIC_AUTH_TOKEN = 'ollama'
    put('ANTHROPIC_MODEL', await $.env.get('ANTHROPIC_MODEL'))
    put('ANTHROPIC_DEFAULT_OPUS_MODEL', await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL'))
    put('ANTHROPIC_DEFAULT_SONNET_MODEL', await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL'))
    put('ANTHROPIC_DEFAULT_HAIKU_MODEL', await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL'))
    put('CLAUDE_CODE_SUBAGENT_MODEL', await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL'))
    return detectBackend(env, { model })
  } catch { return null }
}

// The tab title: the session's name ("<name> · cp:<id>" only when the daemon
// says Go needs the marker, v0.5.5). Claude Code draws the terminal title
// itself (✳ / ◐ + the session's name, repainted about once a second while it
// works), so a raw OSC 2 write is painted over almost at once. Instead the mod
// names the session with Claude Code's own /rename and Claude Code keeps the
// tab titled. (Claude Code's terminalTitleFromRename setting has to stay on,
// which it is by default.) With CLAUDE_CODE_DISABLE_TERMINAL_TITLE set, Claude
// Code draws nothing, so the mod writes OSC 2 to the session's tty instead.
const noTab = () => st.surface === 'headless' || st.surface === 'leftoff' // no terminal tab (claude -p, or started from the board)
function tabTitleOn() { return st.cfg.tabTitle !== false && !st.internal && !noTab() }

function desiredTabTitle(name) {
  const repo = st.record ? repoName(st.record) : null
  return formatTabTitle(st.cfg.tabTitleFormat, { name: name || (st.record && st.record.title) || null, id: st.sessionId, repo, marker: !!(st.tabMarker || st.tabMarkerKept) })
}

// 0.9.9: every /rename the mod runs shows in the session as a "/rename …"
// prompt, and a "you need the marker" answer that came and went every minute
// renamed the tab back and forth all day ("X · cp:207651", "X", …). So, for
// renames the mod does by itself (not /cp-name or a new session id):
// - once the tab carried the marker, it keeps it for this session's lifetime;
// - a change of the marker alone, or the same title again (a rename that
//   failed), waits until TAB_RENAME_COOLDOWN_MS after the last one, and then
//   goes with whatever the title should be by then. A new name goes at once.
async function applyTabTitle($, name, { force = false, current = null } = {}) {
  if (!tabTitleOn() || !st.sessionId) return null
  const title = desiredTabTitle(name)
  if (current && String(current).trim() === title && !st.titleOff) { st.tabTitle = title; if (parseTabTitle(title).id) st.tabMarkerKept = true; return null } // resumed: already named
  if (!title || (!force && title === st.tabTitle)) return null
  const now = Date.now()
  if (!force && tabRenameWaits(st.lastRename, title, { id: st.sessionId, now })) return null
  st.lastRename = { id: st.sessionId, title, at: now }
  st.tabTitle = title
  if (parseTabTitle(title).id && st.tabMarker) st.tabMarkerKept = true
  if (st.titleOff) {
    const tty = st.proc && st.proc.tty
    if (!tty) return null
    try { await $.process.run(['sh', '-c', 'printf "\\033]2;%s\\007" "$1" > "$2"', 'sh', title, tty], { timeoutMs: 2000 }) } catch {}
    return title
  }
  try { await $.command.run({ command: 'rename', args: title }) } catch { st.tabTitle = null }
  return title
}

// A title the daemon or a hook payload reports: adopt it for the tab when it
// isn't our own label coming back.
async function noteTitle($, title) {
  if (!title || parseTabTitle(title).id) return
  if (!st.record) st.record = {}
  st.record.title = title
  if (!st.record.inTurn) await applyTabTitle($, title)
}

// Providers that use the session's own model. Any other provider (ollama,
// ollama-cloud, openai-compatible, heuristic) is the daemon's job: the mod hands
// the work to the daemon instead of calling $.model.complete.
const IN_SESSION_PROVIDERS = ['auto', 'claude', 'anthropic', 'api']

async function callModel($, ctx) {
  const s = st.cfg.summarizer || {}
  if (!IN_SESSION_PROVIDERS.includes(String(s.provider || s.mode || 'auto').toLowerCase())) return null
  const model = ['haiku', 'sonnet', 'opus'].includes(s.model) || !s.model ? (s.model || 'haiku') : s.model
  try {
    const r = await raceTimeout($.model.complete({ model, system: ctx.system, prompt: ctx.prompt, maxTokens: ctx.maxTokens || 300 }), MODEL_TIMEOUT_MS, $)
    if (!r || r.timedOut) return null
    // The types say complete() resolves to the reply's text; the spec sketch
    // mentions { isAnswered }. Accept both.
    // 0.6.8: through Ollama the alias resolves to the Ollama model: name that one.
    const used = st.backend && st.backend.model ? st.backend.model : model
    const backend = st.backend ? st.backend.kind : undefined
    if (typeof r === 'string') return { text: r, model: used, backend }
    if (r.isAnswered === false) return null
    return { text: r.text || '', model: used, backend }
  } catch {
    return null
  }
}

async function writeCheckpointDirect($, cp) {
  let folder = null
  const suffix = '_' + id8(st.sessionId)
  const mine = st.root + '/sessions/' + st.machine
  try {
    const entries = await $.fs.list(mine)
    const hit = entries.find((x) => x.kind === 'directory' && x.name.endsWith(suffix))
    if (hit) folder = hit.name
  } catch {}
  if (!folder) folder = sessionFolderName({ ...st.record, id: st.sessionId, startedAt: st.record.startedAt || cp.createdAt })
  for (let n = 0; n < 20; n++) {
    const file = mine + '/' + folder + '/checkpoints/' + checkpointFileName(cp.createdAt, n)
    let taken = false
    try { taken = await $.fs.exists(file) } catch {}
    if (taken) continue
    const rec = { ...cp, id: checkpointId(st.sessionId, cp.createdAt, n) }
    await $.fs.write(file, renderCheckpointMd({ ...rec, backend: st.backend || undefined }))
    return rec
  }
  return null
}

// length: 'short' | 'informative' | 'long' for this checkpoint only (/cp --short,
// /cp --long); null = config summary.length.
// opts.next (0.8.2, /cp-park): the note is the checkpoint's Next line, word for word.
async function makeCheckpoint($, trigger, userNote, length, opts = {}) {
  if (st.internal || st.checkpointing || !st.sessionId) return null
  st.checkpointing = true
  try {
    const record = { ...(st.record || {}), id: st.sessionId }
    let messages = []
    try { messages = await $.session.messages() } catch {}
    const ctx = buildCheckpointPrompt({ session: record, previous: st.lastCheckpoint, messages, cfg: st.cfg, userNote, length, parent: st.lastCheckpoint ? null : st.clearedFrom || null })
    const reply = await callModel($, ctx)
    let parsed = reply ? parseCheckpointReply(reply.text) : null
    let generator = reply ? { by: 'mod', model: reply.model, ...(reply.backend ? { backend: reply.backend } : {}) } : null
    // 0.9.5: a reply not in the format (a markdown write-up): ask once more, with the format restated
    if (parsed && parsed.parseOk === false) {
      const again = await callModel($, { ...ctx, prompt: retryCheckpointPrompt(ctx.prompt) })
      const p2 = again ? parseCheckpointReply(again.text) : null
      if (p2 && p2.parseOk !== false) parsed = p2
      else if (p2) parsed = betterSalvage(parsed, p2)
      generator = { ...generator, retried: true }
    }
    if (!parsed) {
      // No model answer: let the daemon try its own summarizer, if it's there.
      const r = await api($, 'POST', '/v1/sessions/' + encodeURIComponent(st.sessionId) + '/checkpoints', { trigger, generate: true, userNote: userNote || undefined, length: ctx.length, next: opts.next || undefined }, MODEL_TIMEOUT_MS * 3)
      if (r && r.ok && r.json) return afterCheckpoint($, r.json, trigger)
      parsed = heuristicCheckpoint(messages, record, { length: ctx.length })
      generator = { by: 'heuristic' }
    }
    // 0.9.2: nothing to go on (no prompt, no reply): don't save a placeholder over the last real one
    if (isEmptyCheckpoint(parsed)) { if (trigger === 'manual') $.ui.toast(NOTHING_TO_CHECKPOINT, { timeoutMs: 6000 }); return null }
    if (opts.next) parsed = { ...parsed, next: opts.next }
    const cp = {
      sessionId: st.sessionId, createdAt: nowIso(), trigger, machine: st.machine,
      sessionTitle: record.title || null, repo: record.repo ? repoName(record) : null, branch: (record.repo && record.repo.branch) || null, cwd: record.cwd || null,
      ...(parsed.goal ? { goal: parsed.goal } : {}), ...(parsed.progress ? { progress: parsed.progress } : {}), // 0.9.15
      doing: parsed.doing, stoppedAt: parsed.stoppedAt, next: parsed.next, openQuestion: parsed.openQuestion || null,
      userNote: userNote || null, filesTouched: ctx.filesTouched, turnsSinceLast: record.turnsSinceCheckpoint || 0,
      parseOk: parsed.parseOk, ...(parsed.format === 'markdown' ? { format: 'markdown' } : {}), generator, length: ctx.length,
      decisions: parsed.decisions || [], questions: parsed.questions || [], files: parsed.files || [],
      didntWork: parsed.didntWork || [], recap: parsed.recap || '', nextSteps: parsed.nextSteps || [],
    }
    const r = await api($, 'POST', '/v1/sessions/' + encodeURIComponent(st.sessionId) + '/checkpoints', cp, 2000)
    if (r && r.ok && r.json) return afterCheckpoint($, r.json, trigger)
    const written = await writeCheckpointDirect($, cp)
    return afterCheckpoint($, written || cp, trigger)
  } finally {
    st.checkpointing = false
  }
}

function afterCheckpoint($, cp, trigger) {
  st.lastCheckpoint = cp
  if (st.record) {
    st.record.turnsSinceCheckpoint = 0
    st.record.lastCheckpointAt = cp.createdAt || nowIso()
    if (trigger === 'dormant') st.record.dormantStretch = st.record.lastActivityAt
  }
  $.ui.toast('Checkpoint saved · Next: ' + clip(cp.next, 120), { timeoutMs: 6000 })
  $.ui.invalidate('ui.render')
  return cp
}

async function nameSession($, args) {
  let title = String(args || '').trim()
  if (!title) { $.ui.toast('Usage: /' + st.nameCommand + ' <title>   (or --auto: a new title from the latest messages)'); return {} }
  // 0.9.0: --auto (also auto, -a): the daemon writes a title from the most recent messages
  if (/^(--auto|auto|-a)$/i.test(title)) {
    const r = st.sessionId ? await api($, 'POST', '/v1/sessions/' + encodeURIComponent(st.sessionId) + '/title/auto', {}, 30000) : null
    if (!(r && r.ok && r.json && r.json.title)) { $.ui.toast('Couldn’t make a title: ' + ((r && r.json && r.json.error && r.json.error.message) || 'the Leftoff daemon isn’t answering')); return {} }
    title = r.json.title
    if (tabTitleOn()) { if (!st.record) st.record = {}; st.record.title = title; await applyTabTitle($, title, { force: true }) }
    else { try { await $.command.run({ command: 'rename', args: title }) } catch {} }
    $.ui.toast('Named this session “' + clip(title, 60) + '” (from the latest messages)')
    return {}
  }
  if (tabTitleOn()) {
    if (!st.record) st.record = {}
    st.record.title = title
    await applyTabTitle($, title, { force: true }) // runs /rename "<title>" (plus " · cp:<id>" when Go needs it)
  } else {
    try { await $.command.run({ command: 'rename', args: title }) } catch {}
  }
  await sendOrSpool($, 'title_changed', { title, titleSource: 'custom' })
  $.ui.toast('Named this session “' + clip(title, 60) + '”')
  return {}
}

async function refreshPane($) {
  if (st.paneTimer) {
    // Stop refreshing once the person has closed the pane.
    let open = true
    try { open = (await $.ui.panes()).some((p) => p.id === PANE_ID) } catch {}
    if (!open) { st.paneTimer.cancel(); st.paneTimer = null; return }
  }
  const r = await api($, 'GET', '/v1/sessions?status=active,waiting,background,needs_input,dormant,stale&limit=30', undefined, 1500)
  if (r && r.ok && r.json) {
    // Empty sessions (no prompt yet, v0.4.8) stay off the pane, except this one.
    st.paneRows = r.json.sessions.filter((s) => !s.empty || s.id === st.sessionId).map((s) => ({
      id: s.id, title: s.title || '(untitled)', status: s.status, repo: s.repoLabel || s.repoName, where: (s.repoLabel || s.repoName) + (s.repo && s.repo.branch ? ' · ' + s.repo.branch : ''),
      idleSec: s.idleSec, next: s.latestCheckpoint ? s.latestCheckpoint.next : '', resume: s.resumeCommand,
      live: s.live || 'unknown', canGo: !!(s.jump && s.jump.supported), goWhy: (s.jump && s.jump.reason) || '',
      needs: s.needsYou && s.needsYou.blocking ? s.needsYou : null,
      bg: s.backgroundTasks || 0,
    }))
    st.paneNeeds = st.paneRows.filter((x) => x.needs).length
    st.paneNote = 'Board: http://127.0.0.1:' + st.port + '/ · b opens it'
    // One extra line when the daemon's daily check found a newer version.
    const h = await api($, 'GET', '/v1/health', undefined, 1000)
    const u = h && h.ok && h.json && h.json.update
    if (u && u.available) st.paneNote += ' · update available' + (u.remoteVersion ? ' (v' + u.remoteVersion + ')' : '') + ': run leftoff upgrade'
  } else {
    const rows = []
    try {
      for (const k of await $.store.keys()) {
        if (!String(k).startsWith('session:')) continue
        const s = await $.store.get(k)
        if (!s || s.endedAt) continue
        rows.push({ id: s.id, title: s.title || '(untitled)', status: 'unknown', repo: s.repo ? (s.repo.name || '') : '', where: s.repo ? (s.repo.name || '') : '', idleSec: null, next: s.next || '', resume: resumeCommand(s) })
      }
    } catch {}
    st.paneRows = rows
    st.paneNeeds = 0
    st.paneNote = 'Daemon offline: showing the local registry. Start it with: leftoff serve'
  }
  st.paneRows.sort((a, b) => (b.id === st.sessionId) - (a.id === st.sessionId))
  st.paneAll = st.paneRows
  applyPaneRepo()
  $.ui.invalidate('ui.render')
}

// The pane's repo filter (v0.4.2): `f` steps through the repos with open
// sessions (most recent first), then back to all of them.
function paneRepos() {
  const seen = []
  for (const r of st.paneAll || []) if (r.repo && !seen.includes(r.repo)) seen.push(r.repo)
  return seen
}
function applyPaneRepo() {
  const all = st.paneAll || st.paneRows
  if (st.paneRepo && !all.some((r) => r.repo === st.paneRepo)) st.paneRepo = null
  st.paneRows = st.paneRepo ? all.filter((r) => r.repo === st.paneRepo) : all
  if (st.paneSel >= st.paneRows.length) st.paneSel = Math.max(0, st.paneRows.length - 1)
}
function cyclePaneRepo() {
  const repos = paneRepos()
  const i = st.paneRepo ? repos.indexOf(st.paneRepo) : -1
  st.paneRepo = i + 1 < repos.length ? repos[i + 1] : null
  st.paneSel = 0
  applyPaneRepo()
  return st.paneRepo
}

// Go: bring a session's terminal tab to the front. The CLI runs the jump
// (so macOS asks the terminal, not the daemon, for Automation permission);
// without the CLI on PATH the daemon does it.
async function goTo($, row) {
  if (!row) return
  if (row.id === st.sessionId) { $.ui.toast('That’s this session'); return }
  if (!row.canGo) { $.ui.toast('Can’t jump to “' + clip(row.title, 40) + '”' + (row.goWhy ? ': ' + row.goWhy : ''), { timeoutMs: 8000 }); return }
  // Feedback at once: a slow Go should never look like nothing happened.
  $.ui.toast('Switching to “' + clip(row.title, 40) + '”…', { timeoutMs: 20000 })
  const t0 = Date.now()
  let msg = null
  try {
    const r = await runCli($, ['go', '--id=' + row.id, '--plain'], { timeoutMs: 30000 })
    if (r && (r.exitCode === 0 || r.exitCode === 3)) msg = String(r.stdout || '').trim().split('\n').pop()
  } catch {}
  if (!msg) {
    const r = await api($, 'POST', '/v1/sessions/' + encodeURIComponent(row.id) + '/go', {}, 30000)
    msg = r && r.json ? (r.json.message || (r.json.error && r.json.error.message) || null) : 'Couldn’t reach the daemon'
    if (msg && r && r.json && r.json.elapsedMs != null) msg += ' in ' + (r.json.elapsedMs / 1000).toFixed(1) + ' s'
  }
  if (!msg) msg = 'Switched in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s'
  $.ui.toast(msg, { timeoutMs: 8000 })
}

function needsLine(n) {
  if (n.ask && n.ask.describe) return n.ask.describe.verb + ': ' + n.ask.describe.detail
  if (n.ask && n.ask.questions && n.ask.questions[0]) return n.ask.questions[0].question
  return n.message || n.question || 'waiting'
}

function idleLabel(sec) {
  if (sec == null) return ''
  if (sec < 60) return 'now'
  if (sec < 3600) return Math.round(sec / 60) + 'm'
  return Math.round(sec / 3600) + 'h'
}

const DOT = { active: 'green', waiting: 'yellow', background: 'cyan', needs_input: 'red', dormant: 'gray', stale: 'gray', ended: 'gray' }

// 0.9.13: 'background' reads as what it is: Claude's turn is over, its tasks aren't
function paneStatus(r) {
  if (r.status !== 'background') return r.status
  return r.bg > 0 ? r.bg + ' running' : 'running'
}

function textList() {
  if (!st.paneRows.length) return 'No open sessions. ' + st.paneNote
  return st.paneRows.map((r) => (r.id === st.sessionId ? '▶ ' : '  ') + paneStatus(r).padEnd(11) + ' ' + r.title + ' (' + r.where + ')' + (r.next ? '\n      Next: ' + clip(r.next, 100) : '')).join('\n') + '\n' + st.paneNote
}


// ---------------------------------------------------------------- Needs you (v0.4.4)

// Claude Code shows its permission dialog (or AskUserQuestion's picker) and runs
// this hook beside it; whichever answers first wins (checked on 2.1.295). We put
// the request on the board and long-poll the daemon. Time spent inside
// $.http.fetch doesn't count against the hook's 10 s budget. A board answer is
// returned as the decision; anything else returns what came back from next(e),
// so the terminal decides. Nothing is ever allowed without a person's click.
const ASK_POLL_MS = 20000
const ASK_MAX_MS = 9.5 * 60 * 1000

async function permissionHook($, e, next) {
  const base = await next(e)
  if (st.internal || st.headless || !st.sessionId || (base && base.decision)) return base // headless: the daemon answers on its pipe
  const opened = await api($, 'POST', '/v1/asks', {
    sessionId: e.session_id || st.sessionId, tool: e.tool_name, input: e.tool_input, suggestions: e.permission_suggestions,
    capture: 'mod', cwd: e.cwd, permissionMode: e.permission_mode,
  }, 1500)
  const id = opened && opened.ok && opened.json && opened.json.state === 'waiting' ? opened.json.id : null
  if (!id) return base
  const mine = { tool: e.tool_name, input: e.tool_input, done: false }
  st.asks[id] = mine
  let aborted = false
  // Esc in the terminal abandons the event (next.signal aborts): tell the board.
  try {
    next.signal.addEventListener('abort', () => {
      aborted = true
      if (!mine.done) { mine.done = true; api($, 'POST', '/v1/asks/' + id + '/cancel', { reason: 'cancelled_in_terminal' }, 800).catch(() => {}) }
    })
  } catch {}
  const t0 = Date.now()
  try {
    while (!mine.done && !aborted && Date.now() - t0 < ASK_MAX_MS) {
      const r = await api($, 'GET', '/v1/asks/' + id + '/wait?ms=' + ASK_POLL_MS, undefined, ASK_POLL_MS + 5000)
      if (!r || !r.ok || !r.json) break // daemon gone: the terminal decides
      if (r.json.state === 'answered' && r.json.decision && !aborted && !mine.done) {
        mine.done = true
        return { ...(base || {}), decision: r.json.decision }
      }
      if (r.json.state !== 'waiting') break
    }
  } finally {
    mine.done = true
    delete st.asks[id]
  }
  return base
}

// The tool ran: if the board was still showing its request, the terminal
// answered it first (Claude Code doesn't abandon our hook in that case).
async function toolRan($, e) {
  const ids = Object.keys(st.asks).filter((id) => !st.asks[id].done && st.asks[id].tool === e.tool_name)
  if (!ids.length) return
  for (const id of ids) st.asks[id].done = true
  await api($, 'POST', '/v1/asks/settle', { sessionId: e.session_id || st.sessionId, tool: e.tool_name, input: e.tool_input, reason: 'answered_in_terminal' }, 800)
}

// Replies typed on the board: a long-poll the daemon answers with the next one,
// typed in with $.prompt.submit, which Claude Code runs once the session is idle
// (checked on 2.1.295: a submit during a turn waits for it to end).
function startReplyLoop($) {
  if (st.replyLoop || st.internal || noTab()) return
  st.replyLoop = true
  const loop = async () => {
    let backoff = 0
    while (st.replyLoop && st.sessionId) {
      const sid = st.sessionId
      const r = await api($, 'GET', '/v1/sessions/' + encodeURIComponent(sid) + '/replies/next?ms=' + ASK_POLL_MS, undefined, ASK_POLL_MS + 5000)
      if (!r || !r.ok) {
        // Daemon down: try again on the heartbeat rather than spinning.
        st.replyLoop = false
        return
      }
      const reply = r.json && r.json.reply
      if (reply && reply.text && !String(reply.text).startsWith('/') && sid === st.sessionId) {
        try {
          await $.prompt.submit({ text: String(reply.text) })
        } catch (err) {
          try { $.ui.toast('Leftoff: couldn’t send the board’s reply: ' + String((err && err.message) || err).slice(0, 120)) } catch {}
        }
      }
      backoff = 0
    }
    st.replyLoop = false
  }
  loop().catch(() => { st.replyLoop = false })
}

// 0.7.1: Claude moved (cd, or into a git worktree). Settings-hook payloads carry
// the session's cwd and transcript path, which both follow it into a worktree
// (code.claude.com/docs/en/worktrees), so pass them on when they change.
function moved(e) {
  const out = {}
  const r = st.record || {}
  if (e && typeof e.cwd === 'string' && e.cwd && e.cwd !== r.cwd) out.cwd = e.cwd
  if (e && typeof e.transcript_path === 'string' && e.transcript_path && e.transcript_path !== r.transcriptPath) out.transcriptPath = e.transcript_path
  if (out.cwd && st.hello) st.hello = { ...st.hello, cwd: out.cwd, repo: null } // a hello said again says where it is now
  return out
}

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    try {
      if (await internalOnce($)) { st.internal = true; return next(e) }
      try { await ensureSetup($) } catch {} // the same attempt an early hook may have started; a failure still says hello
      st.sessionId = await $.session.id()
      const cwd = await $.session.cwd()
      const repo = await readRepo($, cwd)
      let model = null
      try { model = await $.session.model() } catch {}
      let surface = null
      try { const surfaces = await $.session.surfaces(); surface = surfaces && surfaces.length ? surfaces[0] : 'headless' } catch {}
      st.headless = await isHeadless($)
      if (st.headless) surface = 'leftoff' // 0.9.9: started from the board, a work session (not 'headless')
      st.record = null
      // Where this session runs: Claude Code's pid + tty (for open/closed and
      // Terminal.app) and the terminal's own ids (for Go).
      st.proc = await probeProcess($)
      const termEnv = await readTermEnv($)
      st.term = detectTerminal(termEnv)
      st.surface = surface
      st.backend = await readBackend($, model)
      st.hello = { cwd, repo, model, backend: st.backend, surface, proc: st.proc ? { ...st.proc, source: 'mod' } : null, term: st.term }
      await sendOrSpool($, 'session.opened', st.hello)
      if (repo) await unlockOwnParkLocks($, cwd) // 0.8.8
      if (st.heartbeat) st.heartbeat.cancel()
      st.heartbeat = $.clock.every(60000, () => { heartbeat($).catch(() => {}); startReplyLoop($) })
      st.ready = true
      startReplyLoop($)
    } catch {}
    // Commands last, each on its own: a taken name throws, so a
    // clash costs only that command, and registerCommands reports it.
    await registerCommands($)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (!(await internalOnce($)) && !st.internal && e.session_id) {
      let parentSessionId
      if (st.sessionId && e.session_id !== st.sessionId) {
        // /clear, /resume or a fork: a new id in the same process.
        parentSessionId = st.sessionId
        st.sessionId = e.session_id
        st.record = { ...(st.record || {}), id: e.session_id, turns: 0, turnsSinceCheckpoint: 0, endedAt: null, title: null, titleSource: null, startedAt: null }
        st.clearedFrom = e.source === 'clear' ? st.lastCheckpoint : null // 0.9.15: a hint for the new session's goal
        st.lastCheckpoint = null
        st.titleSoon = false
        st.daemonTitle = null
        st.tabMarkerKept = false // a new session in this tab: the daemon's answer decides again
        st.tabMarker = false
        if (e.source === 'resume' && e.cwd) await unlockOwnParkLocks($, e.cwd) // 0.8.8: /resume of a parked worktree session
      }
      if (!st.sessionId) st.sessionId = e.session_id
      await sendOrSpool($, 'session.started', {
        source: e.source, transcriptPath: e.transcript_path, cwd: e.cwd, sessionTitle: e.session_title, model: e.model, parentSessionId,
        backend: e.model ? await readBackend($, e.model) : (st.backend || null),
        // a new id in the same process (/clear, /resume) runs in the same tab
        ...(parentSessionId ? { proc: st.proc ? { ...st.proc, source: 'mod' } : null, term: st.term } : {}),
      })
      if (!noTab()) {
        const own = e.session_title ? parseTabTitle(e.session_title) : null
        const name = own && !own.id ? own.name : (own && own.name) || st.daemonTitle || null
        await applyTabTitle($, name, { force: !!parentSessionId, current: e.session_title || null })
      }
    }
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await sendOrSpool($, 'activity', { kind: 'prompt', prompt: clip(e.prompt || '', 300), sessionTitle: e.session_title && e.session_title === st.tabTitle ? null : e.session_title, ...moved(e) }) // our own /rename isn't a name you chose
    return next(e)
  })

  // v0.5.1: when this session's saved lists changed since Claude last heard
  // (saved, ticked on the board, a resumed session), the prompt carries a
  // context entry: the list, its numbers, and `leftoff todo done <list> <n>`.
  // Context goes on the event before next(); on the result it would be too late.
  on('prompt.submit', async ($, e, next) => {
    const ctx = await listContextFor($)
    return next(ctx ? { ...e, context: [...(Array.isArray(e.context) ? e.context : []), ctx] } : e)
  })

  on('turn.start', async ($, e, next) => {
    await sendOrSpool($, 'turn_started', {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // classic.Stop reports a normal end with its details; Stop doesn't fire for
    // an interrupted or failed turn, so those are reported here.
    if (e.reason === 'aborted' || e.reason === 'error' || e.reason === 'refusal') await sendOrSpool($, 'turn_completed', { endReason: e.reason })
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    // v0.5.1: a checklist of 3+ in this reply (a cheap regex, no model) -> the
    // board's card offers "Claude wrote a 7-step list · Save". Nothing is saved here.
    const listHint = listHintFrom(e.last_assistant_message || '', { fallback: st.daemonTitle || null })
    await sendOrSpool($, 'turn_completed', {
      ...moved(e),
      lastAssistantPreview: clip(e.last_assistant_message || '', 280),
      question: trailingQuestion(e.last_assistant_message || ''),
      ...(listHint ? { listHint } : {}),
      backgroundTasks: Array.isArray(e.background_tasks) ? e.background_tasks.length : 0,
      sessionCrons: Array.isArray(e.session_crons) ? e.session_crons.length : 0,
      backgroundList: backgroundListFrom(e.background_tasks, e.session_crons), // 0.9.13: names for the board's "2 tasks running" tip (≤5, short, secrets blanked)
    })
    // The daemon titles a session after its first turn (a few seconds of
    // summarizer); name the tab once it has, without waiting for the minute heartbeat.
    if (st.daemonTitle && !noTab()) await noteTitle($, st.daemonTitle)
    else if (!st.titleSoon && !noTab() && tabTitleOn()) {
      st.titleSoon = true
      $.clock.after(12000, () => { heartbeat($).catch(() => {}) })
    }
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    await sendOrSpool($, 'notification', { notificationType: e.notification_type || null, message: clip(e.message || '', 200), ...moved(e) })
    return next(e)
  })

  on('classic.PermissionRequest', permissionHook)

  on('classic.PostToolUse', async ($, e, next) => {
    await toolRan($, e)
    const m = moved(e) // EnterWorktree, or a cd: say so now, not at the end of the turn
    if (m.cwd || m.transcriptPath) await sendOrSpool($, 'activity', { kind: 'cwd', ...m })
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => { await toolRan($, e); return next(e) })

  on('session.end', async ($, e, next) => {
    // About 1.5 s shared by every SessionEnd hook: post and go. The daemon makes
    // the final checkpoint later from transcript_path.
    await sendOrSpool($, 'session.ended', { reason: e.reason }, END_TIMEOUT_MS)
    if (e.reason !== 'clear' && e.reason !== 'resume' && st.heartbeat) { st.heartbeat.cancel(); st.heartbeat = null; st.replyLoop = false }
    return next(e)
  })

  // No hooks on 'checkpoint' or 'name': those are aliases of the built-in
  // /rewind and /rename, and a hook here would sit in front of them.
  on('command.run', { command: 'cp' }, async ($, e) => checkpointCommand($, e.args))

  on('command.run', { command: 'cp-save' }, async ($, e) => checkpointCommand($, e.args))

  on('command.run', { command: 'cp-name' }, async ($, e) => nameSession($, e.args))

  on('command.run', { command: 'leftoff' }, async ($, e) => paneCommand($, e.args))
  on('command.run', { command: 'cp-catchup' }, async ($, e) => makeCatchup($, e.args))
  on('command.run', { command: 'cp-todo' }, async ($, e) => saveTodo($, e.args))
  on('command.run', { command: 'leftoff-todo' }, async ($, e) => saveTodo($, e.args))
  on('command.run', { command: 'cp-done' }, async ($, e) => tickTodo($, e.args))
  on('command.run', { command: 'leftoff-done' }, async ($, e) => tickTodo($, e.args))
  on('command.run', { command: 'leftoff-catchup' }, async ($, e) => makeCatchup($, e.args))
  on('command.run', { command: 'cp-park' }, async ($, e) => parkCommand($, e.args))
  on('command.run', { command: 'leftoff-park' }, async ($, e) => parkCommand($, e.args))

  on('command.run', { command: 'checkpoints' }, async ($, e) => paneCommand($, e.args))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = (e.props && e.props.bodyColumns) || 60
    const rows = st.paneRows.map((r, i) => Box({
      key: 'row-' + r.id,
      flexDirection: 'column',
      children: [
        Box({ flexDirection: 'row', columnGap: 1, children: [
          Text({ color: i === st.paneSel ? 'cyan' : 'gray', children: [i === st.paneSel ? '›' : ' '] }),
          Text({ dimColor: true, children: [i < 9 ? String(i + 1) : ' '] }),
          Text({ color: r.needs ? 'red' : r.live === 'closed' ? 'gray' : (DOT[r.status] || 'white'), children: [r.needs ? '!' : r.live === 'closed' ? '○' : '●'] }),
          Text({ bold: r.id === st.sessionId, wrap: 'truncate-end', children: [clip(r.title, Math.max(10, width - 18))] }),
          Text({ dimColor: true, children: [idleLabel(r.idleSec)] }),
        ] }),
        Text({ dimColor: !r.needs, color: r.needs ? 'red' : undefined, wrap: 'truncate-end', children: ['  ' + (r.needs ? 'Needs you: ' + needsLine(r.needs) : r.where + (r.next ? ' · Next: ' + r.next : ''))] }),
      ],
    }))
    return Box({
      flexDirection: 'column',
      children: [
        ...(st.paneNeeds ? [Text({ color: 'red', bold: true, children: [st.paneNeeds + (st.paneNeeds === 1 ? ' session needs you' : ' sessions need you') + ' · answer on the board (b) or Go'] })] : []),
        ...(rows.length ? rows : [Text({ dimColor: true, children: ['No open sessions yet.'] })]),
        Text({ children: [' '] }),
        Box({ flexDirection: 'row', columnGap: 2, children: [
          Button({ key: 'up', label: '↑', hotkey: 'k', onPress: async () => { st.paneSel = Math.max(0, st.paneSel - 1); $.ui.invalidate('ui.render') } }),
          Button({ key: 'down', label: '↓', hotkey: 'j', onPress: async () => { st.paneSel = Math.min(Math.max(0, st.paneRows.length - 1), st.paneSel + 1); $.ui.invalidate('ui.render') } }),
          Button({ key: 'go', label: 'Go', hotkey: 'g', onPress: async () => { await goTo($, st.paneRows[st.paneSel]) } }),
          ...st.paneRows.slice(0, 9).map((r, i) => Button({ key: 'go' + (i + 1), label: String(i + 1), hotkey: String(i + 1), onPress: async () => { st.paneSel = i; await goTo($, r) } })),
        ] }),
        Box({ flexDirection: 'row', columnGap: 2, children: [
          Button({ key: 'cp', label: 'Checkpoint', hotkey: 'c', onPress: async () => { await makeCheckpoint($, 'manual', null) } }),
          Button({ key: 'copy', label: 'Copy resume', hotkey: 'r', onPress: async () => {
            const me = st.paneRows.find((r) => r.id === st.sessionId)
            const cmd = me ? me.resume : resumeCommand({ id: st.sessionId, cwd: st.record && st.record.cwd, backend: st.backend || undefined })
            try { await $.ui.copy(cmd); $.ui.toast('Copied: ' + cmd) } catch { $.ui.toast(cmd, { timeoutMs: 10000 }) }
          } }),
          Button({ key: 'ui', label: 'Open board', hotkey: 'b', onPress: async () => { await openBoard($) } }),
          Button({ key: 'catchup', label: 'Catch me up', hotkey: 'u', onPress: async () => {
            $.ui.toast('Catching you up…')
            const r = await makeCatchup($, '')
            $.ui.toast(String((r && r.text) || '').split('\n').filter(Boolean).slice(0, 3).join(' · '), { timeoutMs: 12000 })
          } }),
          Button({ key: 'repo', label: st.paneRepo ? 'Repo: ' + st.paneRepo : 'Repo: all', hotkey: 'f', onPress: async () => {
            const now = cyclePaneRepo()
            $.ui.toast(now ? 'Showing ' + now + ' (' + st.paneRows.length + ') · f for the next repo' : 'Showing all repos')
            $.ui.invalidate('ui.render')
          } }),
        ] }),
        Text({ dimColor: true, children: [st.paneNote] }),
      ],
    })
  })
}
