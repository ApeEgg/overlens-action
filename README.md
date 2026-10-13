# overlens-action

The reusable workflow and crawl engine behind [Overlens](https://overlens.korte.kim)
— visual regression review, straight from GitHub.

On every successful deployment it crawls the deploy, screenshots every
reachable page across viewport/theme passes, diffs against the baseline,
pushes `overlens/dev` and `overlens/pr-{n}` snapshot branches and maintains
a summary in the source PR — all inspectable at
`overlens.korte.kim/{owner}/{repo}/pull/{n}`.

## Usage

Your repo needs an [`overlens.config.ts`](https://overlens.korte.kim) at the
root (see the install guide for the template) and this workflow:

```yaml
name: Overlens
on:
  deployment_status:
  pull_request:
    types: [closed]

concurrency:
  group: overlens-${{ github.event.deployment.ref || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  overlens:
    uses: apeegg/overlens-action/.github/workflows/overlens.yml@v3
    permissions:
      contents: write
      pull-requests: write
```

The crawl brings its own pinned Playwright, matched to its container image —
your repo installs nothing, and your `overlens.config` is imported straight
from source, so it must stay free of npm dependencies (type-only imports are
erased and fine).

## Inputs

All optional — the defaults cover Vercel on hosted runners.

| input | default | |
| --- | --- | --- |
| `environments` | `Preview\|Production` | regex a deployment's environment name must match |
| `inspector` | `https://overlens.korte.kim` | origin the report links point to |
| `runner` | `ubuntu-latest` | runner label for all jobs |

## Pressed states

A drawer, menu or dialog is only on screen after a click. Mark the element
that opens it with `data-overlens-press` and the crawl shoots the opened state
too — no config needed:

```html
<button data-overlens-press="edit-drawer">Edit</button>
```

After a page's own passes, each pass (viewport and theme) presses every
marked element on screen, waits until running animations finish and the page
settles, and shoots `<viewport>-<theme>/<page>~<state>.png`. Marked elements
the opened state reveals — a press inside the drawer — are pressed next and
shot as `<page>~<state>~<nested>.png`. Each state lands as its own page in the
report and diff.

- **Identity** — the attribute value names the state and identifies the
  element, so elements sharing a value are one press. A bare
  `data-overlens-press` falls back to the element's child-index path
  (`home~2.1.3.png`), which moves whenever the markup does — give presses a
  value.
- **Once per pass** — no element is pressed twice within a page's crawl, so a
  button still visible behind its own drawer isn't explored again, and a
  valued press is shot once per pass across the whole crawl: the same drawer
  opened from several pages is one state, filed under the first page that
  reached it. Give each distinct state its own value, and the same value
  wherever it opens the same thing.
- **Reveals** — a press that only exposes other presses, like a dropdown menu
  whose items open drawers, is marked `data-overlens-reveal` instead. It is
  pressed to reach what it reveals and never shot or listed itself; the
  presses behind it are named as if they sat on the page —
  `<page>~<state>.png`, not `<page>~<menu>~<state>.png`:

  ```html
  <button data-overlens-reveal="actions">Actions</button>
  <!-- rendered once the menu is open -->
  <button data-overlens-press="share-drawer">Share</button>
  ```

- **No leaks** — every state starts from a fresh load of the page and replays
  its press chain. State the press persists (localStorage, the server) does
  carry over, so only mark presses that open things.
- **Time** — each state is a full page load, counted against
  `timeoutMinutes`.

## Developing

`fixture/run.sh` crawls a small fixture site — a drawer with a nested press
inside it, a reveal menu, and a second page sharing a press with the first —
with the engine end to end and lists the snapshots it took into
`fixture/.overlens/crawler/overlens-output`. It needs bun and Playwright's
chromium locally.
