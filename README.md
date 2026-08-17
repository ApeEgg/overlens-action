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
    uses: apeegg/overlens-action/.github/workflows/overlens.yml@v1
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
