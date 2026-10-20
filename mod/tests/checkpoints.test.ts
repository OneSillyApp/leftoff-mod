// Tests for `claude plugin test` (Claude Code's own mod test kit).
// Run with Claude Code's own test kit: `claude plugin test ./mod` (passes on
// 2.1.295). The same behavior is exercised in Node by test/mod-harness.mjs.
import { expect, mock, test } from 'claude-code/testing'

const SID = '7a1e0b55-0c1d-4e6f-8a9b-1c2d3e4f5a6b'

function stubBasics(on: any, posts: any[], { taken = [] as string[], logs = [] as string[], registered = [] as string[], env = {} as Record<string, string>, run = null as any, fetch = null as any, messages = null as any } = {}) {
  mock.env(on, { HOME: '/home/yourname', CHECKPOINTS_MACHINE: 'laptop', ...env })
  on('fs.read', (_$: any, e: any) => ({ value: String(e.path).endsWith('token') ? 'tok\n' : '{"port":7429}' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', run || (() => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '' } })))
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: '/work/acme' }))
  on('session.repo', () => ({ value: { root: '/work/acme', remote: null, internal: false, name: null } }))
  on('session.model', () => ({ value: 'claude-opus-5' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.messages', () => ({ value: messages || [{ role: 'user', text: 'add /health', toolUses: [] }, { role: 'assistant', text: 'Done. Wire it into the LB?', toolUses: [] }] }))
  on('command.register', (_$: any, e: any) => {
    if (taken.includes(e.name)) return { deny: '"/' + e.name + '" refused: it is the built-in /' + e.name }
    registered.push(e.name)
    return { value: undefined }
  })
  mock.clock(on)
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_$: any, e: any) => { logs.push(typeof e === 'string' ? e : (e && e.text) || JSON.stringify(e)); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('http.fetch', fetch || ((_$: any, e: any) => {
    posts.push(e)
    const url = String(e.url || '')
    const body = url.endsWith('/checkpoints') ? JSON.stringify({ id: 'cp_1', next: 'YOU: decide on the LB check.', createdAt: '2026-10-09T12:00:00Z' }) : '{"ok":true}'
    return { value: { status: url.endsWith('/checkpoints') ? 201 : 200, ok: true, headers: {}, text: body } }
  }))
  on('session.start', () => ({ cwd: '/work/acme' }))
}

test('session.start posts session.opened to the daemon', async ($, on) => {
  const posts: any[] = []
  stubBasics(on, posts)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/acme' })
  const opened = posts.find((p) => String(p.url).endsWith('/v1/events'))
  expect(JSON.parse(opened.init.body).events[0].type).toBe('session.opened')
})

test('/cp asks the model and posts the checkpoint', async ($, on) => {
  const posts: any[] = []
  stubBasics(on, posts)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Doing: Adding /health.\nStopped at: Tests pass.\nNext: YOU: decide on the LB check.' } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/acme' })
  const answer = await $.command.run({ command: 'cp', args: 'before lunch' })
  expect(answer).toEqual({})
  const cp = posts.find((p) => String(p.url).endsWith('/checkpoints'))
  const body = JSON.parse(cp.init.body)
  expect(body.trigger).toBe('manual')
  expect(body.userNote).toBe('before lunch')
  expect(body.next).toBe('YOU: decide on the LB check.')
})

test('commands: /cp, /cp-name, /leftoff (+ /checkpoints, its old name), /cp-catchup; a taken /cp falls back to /cp-save, and the result reaches the daemon', async ($, on) => {
  const posts: any[] = []
  const logs: string[] = []
  const registered: string[] = []
  stubBasics(on, posts, { taken: ['cp'], logs, registered })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/acme' })
  expect(registered).toEqual(['cp-save', 'cp-name', 'leftoff', 'checkpoints', 'cp-catchup', 'cp-todo', 'cp-park', 'cp-done'])
  expect(logs.join('\n')).toContain('using /cp-save instead of /cp')
  const health = posts.find((p) => String(p.url).endsWith('/v1/mod/health'))
  const body = JSON.parse(health.init.body)
  expect(body.commands.map((c: any) => c.name)).toEqual(['cp-save', 'cp-name', 'leftoff', 'checkpoints', 'cp-catchup', 'cp-todo', 'cp-park', 'cp-done'])
  expect(body.commands.every((c: any) => c.ok)).toBe(true)
})

test('session.start reports where it runs: Claude Code pid + tty from one sh probe, and the terminal from env', async ($, on) => {
  const posts: any[] = []
  const run = (_$: any, e: any) => {
    const argv = e.argv || []
    if (argv[0] === 'sh') return { value: { exitCode: 0, stdout: '4242 ttys003 01:00\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: 'main\n', stderr: '' } }
  }
  stubBasics(on, posts, { env: { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' }, run })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/acme' })
  const opened = posts.find((p) => String(p.url).endsWith('/v1/events'))
  const data = JSON.parse(opened.init.body).events[0].data
  expect(data.proc.pid).toBe(4242)
  expect(data.proc.tty).toBe('/dev/ttys003')
  expect(data.term.kind).toBe('ghostty')
})


test('/cp-catchup (v0.5.0): prepare, then this session\'s model writes the summary, then the daemon saves it', async ($, on) => {
  const posts: any[] = []
  stubBasics(on, posts, { fetch: (_$: any, e: any) => {
    posts.push(e)
    const url = String(e.url || '')
    if (url.endsWith('/v1/catchups/prepare')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ window: { from: '2026-10-09T13:00:00Z', to: '2026-10-10T13:00:00Z', label: 'Last 24 hours' }, sessions: 1, prompt: { system: 'You catch a developer up', prompt: 'Repo acme: ...', maxTokens: 600 } }) } }
    if (url.endsWith('/v1/catchups')) {
      const b = JSON.parse(e.init.body)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ name: '2026-10-10T0800', path: 'catchups/2026-10-10T0800.md', summary: { bullets: b.summary ? b.summary.bullets : ['none'] }, recap: { window: { label: 'Last 24 hours' }, sessions: [{ title: 'Health endpoint', repo: 'acme', state: 'idle', next: 'Wire the LB check' }], repos: [{ label: 'acme' }], needsYou: [] } }) } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  } })
  on('model.complete', () => ({ value: { isAnswered: true, text: '- Health endpoint is done.\n- Next: the LB check.' } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/acme' })
  const answer: any = await $.command.run({ command: 'cp-catchup', args: '24h acme' })
  const prep = posts.find((p) => String(p.url).endsWith('/v1/catchups/prepare'))
  expect(JSON.parse(prep.init.body)).toEqual({ since: '24h', repos: ['acme'] })
  const made = posts.find((p) => String(p.url).endsWith('/v1/catchups'))
  const body = JSON.parse(made.init.body)
  expect(body.to).toBe('2026-10-10T13:00:00Z')
  expect(body.summary.bullets).toEqual(['Health endpoint is done.', 'Next: the LB check.'])
  expect(body.summary.provider).toBe('claude-in-session')
  expect(String(answer.text)).toContain('Saved catchups/2026-10-10T0800.md')
})

test('/cp-todo (v0.5.1): saves the checklist Claude just wrote, named from its heading', async ($, on) => {
  const posts: any[] = []
  const LIST = 'Here are the next steps to submit to the App Store:\n\n1. Create the app record\n2. Fill in the privacy label\n3. Upload the build'
  let saved: any = null
  stubBasics(on, posts, { fetch: (_$: any, e: any) => {
    posts.push(e)
    const url = String(e.url || '')
    const item = (n: number, text: string) => ({ n, text, done: false })
    const list = { ref: 'acme/next-steps-to-submit-to-the-app-store', name: 'Next steps to submit to the App Store', total: 3, done: 0, progress: '0/3', items: [item(1, 'Create the app record'), item(2, 'Fill in the privacy label'), item(3, 'Upload the build')] }
    if (url.endsWith('/v1/lists') && e.init.method === 'POST') { saved = JSON.parse(e.init.body); return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, list }) } } }
    if (url.endsWith('/lists')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ lists: saved ? [list] : [], signature: saved ? 'sig1' : null, context: saved ? 'Leftoff is tracking a checklist … run: leftoff todo done acme/next-steps-to-submit-to-the-app-store <n>' : '' }) } }
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  }, messages: [{ role: 'user', text: 'next steps?', toolUses: [] }, { role: 'assistant', text: LIST, toolUses: [] }] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/acme' })
  const answer: any = await $.command.run({ command: 'cp-todo', args: '' })
  expect(saved.items.length).toBe(3)
  expect(saved.name).toBe('Next steps to submit to the App Store')
  expect(String(answer.text)).toContain('Saved "Next steps to submit to the App Store" (3 items)')
})
