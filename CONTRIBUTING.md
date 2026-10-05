# Contributing to Vigame

Vigame is its author's project, built by talking to an AI model rather than
by writing code by hand. Bug reports and ideas are welcome as
[issues](https://github.com/Andrejs4/vigame/issues), with nothing more
asked of them.

Pull requests are welcome too, but only those that follow this page are
considered. Others are closed without review. Following it gets a pull
request considered, not merged: the author may still decline it.

## Which pull requests are considered

1. **A few lines**: about ten changed lines in all, such as a typo, a wrong
   number or a one-line bug fix. Say what it fixes and how you checked it.

2. **Anything bigger** also needs all three of these:
   - **The model**: the name and version of each AI model that wrote or
     changed the code, as the tool you used showed them, and that tool.
     If you wrote it by hand, say so.
   - **The original prompt**: what you asked the model, word for word, from
     your first prompt on. A link to the shared conversation or session
     will do, if it shows them all.
   - **Who you are**: the author knows you, or you give references for your
     reputation. These can be a public profile with a history of your own
     work, projects you maintain, contributions merged into other known
     projects, or someone the author knows who will vouch for you.

The pull request template asks for each of these.

## What every pull request needs

- One subject. Unrelated changes go in separate pull requests.
- `npm test` and `npm run smoke` pass, and you say so.
- The code is GPL-2.0-or-later, like the rest. Pictures carry a licence
  that allows them here and their line in `src/client/art/CREDITS.md`.
- No trackers, ads or outside services, and no npm packages in the page
  (`src/`).
- [CLAUDE.md](CLAUDE.md) holds the project's rules for working on the code:
  give it to your model.

For something bigger, open an issue first and ask whether it is wanted.

## Why

The author plays the game and works through an AI model; he doesn't read
the code. For him the prompt is the real source of a change. It shows what
was asked, so the change can be checked against it, or made again. What is
merged runs on his server, so he needs to know who sent it.

The author's own pull requests, from his own sessions, are outside this
page.
