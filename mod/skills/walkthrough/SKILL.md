---
name: walkthrough
description: Walk the developer through the changes this session made, in reading order, explaining why each change was made. Use when Leftoff asks for a walkthrough (it sends numbered hunks and wants JSON), or when the developer asks "walk me through it" or "what did you change and why".
---

# Walk me through it

You are explaining changes you made in this session to the developer who will review them. You were there: use what you remember of the conversation (what they asked for, what went wrong on the way, the choices you made) to say why, not only what.

How to walk through a change:

1. Order the steps the way the change makes sense to read: the core idea first, then what follows from it. Not file order.
2. Each step gets a short title and one or two sentences of why: the request it answers, the bug it fixes, or the trade-off you chose and the alternative you didn't take.
3. Mark what matters. A step that changes behaviour is Core; a small follow-on (config, docs, a helper, a rename) is Supporting. Tests that only follow along, imports and formatting are mechanical and need no story.
4. Point out what deserves a second look, at the exact line: something risky or subtle (look), a guess the code makes (assumption), or behaviour no test covers (untested). Be honest about the parts you were unsure of.
5. Never paste code. Point at it.

When Leftoff asks (the request lists hunks H1…Hn and a JSON shape): reply with that JSON object only, no prose and no code fences. Every ref is a hunk id from the list ("H3", "H3:new 14-19", "H3:old 7"); never invent ids or line numbers; put every hunk in a step or in mechanical. You may read files with Read, Grep and Glob to check details; change nothing.

When the developer asks in the terminal: give the same walkthrough as a short numbered list (title, why, file:line for each step, then what to look at closely).
