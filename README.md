# Leftoff for Claude Code

The Claude Code plugin behind [Leftoff](https://leftoff.dev) ("WTF was I working on?").
Version 0.9.12.

It keeps track of every Claude Code session on your machine and writes a short
checkpoint (what you were doing, where it stopped, what's next) when a session
goes quiet.

## On its own

Without the Leftoff app, the plugin:

- adds `/cp` to write a checkpoint of the current session now, `/cp-name` to
  name the session, and `/cp-park` to checkpoint it with a note and exit
- adds a `/leftoff` pane listing your open sessions and their status
- checkpoints a session by itself when it goes quiet
- writes checkpoints as plain Markdown in `~/checkpoints`, using the model of
  the session you're in (no other service is called; if the model doesn't
  answer, a plain summary is built locally)

## With the Leftoff app

With Leftoff installed (`npm i -g @leftoff/cli`, then `leftoff setup`), the
plugin reports to the local Leftoff daemon on `127.0.0.1:7429`, which adds the
web board, automatic checkpoints for dormant sessions, a daily digest,
"catch me up", lists, Live and Ask. See [leftoff.dev](https://leftoff.dev).

**If you installed Leftoff from npm, you already have this plugin.** `leftoff
setup` installs it for you (as `leftoff@checkpoints`) and keeps it in step
with the app. Don't add this marketplace as well, or the plugin runs twice.

## Install (plugin only)

```
claude plugin marketplace add OneSillyApp/leftoff-mod
claude plugin install leftoff@leftoff
```

## Tests

`mod/tests/` runs with Claude Code's own plugin test kit:
`claude plugin test ./mod`.

## Contributing

Issues and pull requests are welcome. This repo is a mirror: the plugin is
developed inside the Leftoff app's repository, which is private, and copied
here on each release. A merged pull request gets applied there and comes back
with the next release, so this repo's history is release snapshots.

## License

MIT License (MIT). See [LICENSE](LICENSE).
The rest of Leftoff (the daemon, board and CLI) is not covered by this license.
