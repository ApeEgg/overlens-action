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
    uses: apeegg/overlens-action/.github/workflows/overlens.yml@v4
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
that opens it with a bare `data-overlens-press` and the crawl shoots the
opened state too — no config needed:

```html
<button data-overlens-press>Edit</button>
```

The attribute counts when it's bare, empty or `"true"` — React renders a bare
JSX `<button data-overlens-press>` as `data-overlens-press="true"`. Any other
value, `"false"` included, isn't a press.

After a page's own passes, each pass (viewport and theme) presses every
marked element on screen, waits until running animations finish and the page
settles, and shoots whatever the press produced — a drawer, a menu, a modal,
revealed content, anything. The crawl never looks at what opened. The state
is named after the pressed element's own label (`aria-label`, else its text)
and shot as `<viewport>-<theme>/<page>~<name>.png`. Marked elements the
pressed state shows are pressed next and shot as `<page>~<name>~<nested>.png`.
When two presses on a page share a name, the later one gets its place among
the page's presses appended, `<page>~<name>-<n>.png`.

- **One shot per group** — marked elements with the same tag-and-class
  ancestry are a group (the rows of a list). A state is identified by its page
  and the group of the press that produced it, so only the first of a group is
  pressed and shot; ten rows opening a drawer titled with their own record
  give one snapshot, named after the first row. The flip side: siblings that
  share ancestry but open different things (tabs, a toolbar of plain
  buttons) are one group too, so give each a class of its own when every one
  should be shot.
- **Per page** — the same drawer reached from several pages is shot under
  each of them.
- **Pressed once** — each marked element is recorded by its place among the
  page's presses, so nothing is pressed twice within a page's crawl and a
  button still visible behind its own drawer isn't explored again.
- **No leaks** — every state starts from a fresh load of the page and replays
  its press chain. State the press persists (localStorage, the server) does
  carry over, so only mark presses that open things.
- **Time** — each press is a full page load, counted against
  `timeoutMinutes`; the rest of a group is never pressed, so it costs nothing.

## Masks

Content that changes on every render — a clock, an avatar, a live counter —
is covered with a solid box in every screenshot when its element carries
`data-overlens-mask`:

```html
<time data-overlens-mask>12:04</time>
```

The attribute counts when it's bare, empty or `"true"` — React renders a bare
JSX `<time data-overlens-mask>` as `data-overlens-mask="true"`. Any other value,
`"false"` included, leaves the element unmasked. The config's `mask` adds CSS
selectors on top; it never replaces the attribute.

## Developing

`fixture/run.sh` crawls a small fixture site — a drawer with a nested press
inside it, a menu whose item opens a drawer, three rows opening a drawer
titled with their own record, a masked element, and a second page opening a
drawer the first page also opens — with the engine end to end and lists the snapshots it
took into `fixture/.overlens/crawler/overlens-output`. It needs bun and Playwright's
chromium locally.
