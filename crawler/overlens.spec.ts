import { writeFileSync } from "fs";

import { expect, test, type Page } from "@playwright/test";

// The workflow runs this from .overlens/crawler inside the consumer's
// workspace — the repo's overlens.config sits two levels up.
import overlens from "../../overlens.config";

test.skip(!process.env.OVERLENS, "overlens crawl runs in CI only");
test.describe.configure({ retries: 0 });

const shape =
  overlens.shape ??
  ((path: string) => path.replace(/\/(?=[^/]*\d)[^/]{8,}/g, "/[id]"));
const mask = overlens.mask ?? ["[data-apply-playwright-mask]"];
type Pass = (typeof overlens.passes)[number];

const clock = (page: Page, timestamp: number) =>
  page.addInitScript(`{
  Date = class extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super(${timestamp});
      } else {
        super(...args);
      }
    }
  }
  const __DateNowOffset = ${timestamp} - Date.now();
  const __DateNow = Date.now;
  Date.now = () => __DateNow() + __DateNowOffset;
}`);

const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
// Entries resolve against the deploy URL, so both plain paths ("/") and
// absolute URLs (a vendor subdomain) work.
const entries = (overlens.pagesIncluded ?? ["/"]).map((p) => new URL(p, base));
const excluded = (path: string) =>
  overlens.pagesExcluded?.some((p) => path === p || path.startsWith(`${p}/`));

const tokens = [...new Set([...entries.map((u) => u.host), new URL(base).host])]
  .sort((a, b) => b.length - a.length)
  .map((host): [string, string] => [host, "overlens.app"]);

const fileBase = (shaped: string) =>
  shaped === "/"
    ? "home"
    : shaped.slice(1).replaceAll("_", "__").replaceAll("/", "_");

const normalize = (page: Page) =>
  page.evaluate((pairs) => {
    const swap = (text: string) =>
      pairs.reduce((t, [host, token]) => t.replaceAll(host, token), text);
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (pairs.some(([host]) => node!.nodeValue?.includes(host)))
        node.nodeValue = swap(node.nodeValue!);
    document
      .querySelectorAll<HTMLInputElement>("input, textarea")
      .forEach((el) => {
        if (pairs.some(([host]) => el.value.includes(host)))
          el.value = swap(el.value);
      });
  }, tokens);

// A page is ready to screenshot when it has stopped changing, not when the
// network went idle at goto time: state arriving over a websocket mounts
// content long after networkidle, and those mounts fire fresh component
// fetches goto never saw. Quiescence is observed directly — no running
// finite animation, no network event and no DOM mutation for 400ms, capped
// at 10s so a page that never goes quiet is shot as-is, masks covering its
// known tickers. Animations are awaited, not polled: a drawer sliding open
// is done exactly when its animation finishes. Infinite ones (spinners)
// never finish and are left to the masks.
//
// A timestamp, not a set of pending requests: some requests emit a request
// event and then neither requestfinished nor requestfailed, and one such leak
// poisons a set permanently — the page would never look idle again. An event
// that never arrives simply stops bumping the clock.
const lastRequestOf = new WeakMap<Page, { at: number }>();

const trackRequests = (page: Page) => {
  const seen = { at: Date.now() };
  lastRequestOf.set(page, seen);
  const bump = () => (seen.at = Date.now());
  page.on("request", bump);
  page.on("requestfinished", bump);
  page.on("requestfailed", bump);
};

const observeMutations = (page: Page) =>
  page.addInitScript(`
  new MutationObserver(() => { window.__overlensLastMutation = performance.now(); }).observe(
    document,
    { subtree: true, childList: true, attributes: true, characterData: true },
  );`);

const settled = async (page: Page) => {
  const seen = lastRequestOf.get(page)!;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await page.evaluate(() =>
      Promise.allSettled(
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === "running" &&
              a.effect?.getComputedTiming().endTime !== Infinity,
          )
          .map((a) => a.finished),
      ),
    );
    if (
      Date.now() - seen.at > 400 &&
      (await page.evaluate(
        () =>
          performance.now() -
            ((window as { __overlensLastMutation?: number })
              .__overlensLastMutation ?? 0) >
          400,
      ))
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

// Elements marked data-overlens-press open a state worth its own snapshot —
// a drawer, a menu, a dialog. Only those on screen count:
// rendered, not inert, not parked beside the viewport (a closed off-canvas
// drawer). An element's identity is its attribute value, so equal values are
// one press and the value names the snapshot; a bare attribute — or "true",
// which is how React renders a bare JSX data-* attribute — is identified by
// its place among the page's presses: the page's 3rd press is <page>~3,
// whatever markup surrounds it.
type Press = {
  id: string;
  name: string;
  selector: string;
  valued: boolean;
};

const pressables = (page: Page) =>
  page.evaluate(() => {
    const found = new Map<string, Press>();
    for (const el of document.querySelectorAll<HTMLElement>(
      "[data-overlens-press]",
    )) {
      const { left, right, width, height } = el.getBoundingClientRect();
      if (
        !width ||
        !height ||
        right <= 0 ||
        left >= innerWidth ||
        el.closest("[inert]") ||
        !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      )
        continue;
      const value = el.dataset.overlensPress?.replace(/^true$/, "");
      const nth = [...document.querySelectorAll("[data-overlens-press]")].indexOf(el);
      const id = value || String(nth + 1);
      if (!found.has(id))
        found.set(id, {
          id,
          name: id.replace(/[^\w.-]+/g, "-"),
          selector: value
            ? `[data-overlens-press="${CSS.escape(value)}"]`
            : `[data-overlens-press] >> nth=${nth}`,
          valued: !!value,
        });
    }
    return [...found.values()];
  });

// A page can wedge its own main thread (an app bug: an infinite render/
// navigate loop). Playwright's evaluate has no timeout, so without a deadline
// one broken page hangs the whole crawl silently until CI kills it. The
// deadline covers everything legitimate (goto 30s + ready + four passes on a
// slow runner; each pressed state gets its own); a page that busts it is
// unusable — no CDP call will ever return — so the crawl closes it and
// continues on a fresh one.
const PAGE_DEADLINE = 90_000;
const withDeadline = <T>(work: () => Promise<T>) => {
  let timer: ReturnType<typeof setTimeout>;
  const working = work();
  // The losing arm still rejects later (its page gets closed) — mark it
  // handled so the crawl doesn't die on an unhandled rejection.
  working.catch(() => {});
  return Promise.race([
    working,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`page deadline ${PAGE_DEADLINE}ms exceeded`)),
        PAGE_DEADLINE,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

test("overlens crawl", async ({ context }) => {
  test.setTimeout((overlens.timeoutMinutes ?? 15) * 60 * 1000);

  const preparePage = async (target: Page) => {
    trackRequests(target);
    await observeMutations(target);
    await target.emulateMedia({ reducedMotion: "reduce" });
    if (overlens.freezeClock ?? true)
      await clock(target, Date.UTC(2026, 7, 11, 12));
    for (const pattern of overlens.blockRequests ?? [])
      await target.route(pattern, (route) => route.abort());
  };

  // Login runs on a pristine page, as a person would: the determinism
  // treatments exist for screenshots, and freezing the clock during a live
  // login makes freshly issued tokens look like they're from the future —
  // OIDC iat/nbf validation then rejects the session. Cookies and
  // localStorage live on the context, so the session survives the close.
  if (overlens.auth) {
    const login = await context.newPage();
    await overlens.auth(login);
    await login.close();
  }

  let page = await context.newPage();
  await preparePage(page);

  // The page may be wedged beyond recovery — replace it. Cookies and
  // storage live on the context, so the session carries over.
  const replacePage = async () => {
    await page.close().catch(() => {});
    page = await context.newPage();
    await preparePage(page);
  };

  const load = async (url: string) => {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await overlens.ready?.(page);
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({
      content:
        "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }",
    });
  };

  const frame = async ({ width, theme }: Pass) => {
    await page.setViewportSize({ width, height: 720 });
    await overlens.theme(page, theme);
  };

  const shoot = async (file: string) => {
    await normalize(page);
    await settled(page);
    await page.evaluate(() =>
      Promise.all(
        [...document.images].map((img) => img.decode().catch(() => {})),
      ),
    );
    await page.screenshot({
      path: `overlens-output/${file}.png`,
      fullPage: true,
      mask: mask.map((selector) => page.locator(selector)),
    });
  };

  // Entry pages keep their full href (query and all); every other page is
  // origin + path.
  const entryOf = new Map(
    entries.map((u) => [u.pathname.replace(/\/$/, "") || "/", u.href]),
  );
  const seen = new Set<string>();
  const queue = [...entryOf.keys()];
  // Captured page shapes, each pressed state listed as <shape>~<state>.
  const pages = new Set<string>();
  // Valued presses already shot, per pass, across the whole crawl.
  const shotOf = new Map<Pass, Set<string>>();

  while (queue.length) {
    const path = queue.shift()!.replace(/\/$/, "") || "/";
    if (seen.has(path)) continue;
    seen.add(path);
    if (excluded(path)) continue;
    const pathShape = shape(path);
    // `shape` declares these paths to be the same page, so a second instance
    // has nothing to add: same screenshot, same links. Collapsing them is the
    // whole point of shaping. A shape only counts as captured once a visit
    // succeeds, so a page that fails still lets its siblings stand in.
    if (pages.has(pathShape)) continue;
    const url = entryOf.get(path) ?? `${entries[0].origin}${path}`;
    const presses = new Map<Pass, Press[]>();
    const started = Date.now();

    try {
      await withDeadline(async () => {
        await load(url);
        for (const pass of overlens.passes) {
          await frame(pass);
          await shoot(`${pass.name}/${fileBase(pathShape)}`);
          presses.set(pass, await pressables(page));
        }
        const hrefs = await page
          .locator("a[href^='/']:not([href^='//'])")
          .evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
        queue.push(...hrefs.map((href) => href.split(/[?#]/)[0]));
        pages.add(pathShape);
      });
      console.info(
        `${pathShape} ${Date.now() - started}ms (visited ${seen.size}, queued ${queue.length})`,
      );
    } catch (error) {
      console.info(
        `${pathShape} skipped (${String((error as Error)?.message || error).split("\n")[0]})`,
      );
      await replacePage();
      continue;
    }

    // Every pressed state starts from a fresh load and replays its press
    // chain, so no state leaks into another — a press inside an opened drawer
    // is shot as drawer~press. Each element is pressed once per pass: what a
    // state reveals is only explored when no earlier state claimed it, and a
    // valued press shot on one page is never pressed again on another — the
    // same drawer opened from two pages is one state, filed under the page
    // that reached it first.
    for (const [pass, roots] of presses) {
      const shot = shotOf.get(pass) ?? shotOf.set(pass, new Set()).get(pass)!;
      const claimed = new Set<string>();
      const fresh = (press: Press) =>
        !claimed.has(press.id) && !(press.valued && shot.has(press.id));
      const take = (found: Press[]) => {
        const taken = found.filter(fresh);
        taken.forEach((press) => claimed.add(press.id));
        return taken;
      };
      const chains = take(roots).map((press) => [press]).reverse();
      while (chains.length) {
        const chain = chains.pop()!;
        const last = chain.at(-1)!;
        const suffix = chain.map((press) => `~${press.name}`).join("");
        const state = `${pathShape}${suffix}`;
        const pressed = Date.now();
        try {
          await withDeadline(async () => {
            await load(url);
            await frame(pass);
            for (const { selector } of chain) {
              await page.locator(selector).filter({ visible: true }).first().click();
              await settled(page);
            }
            await shoot(`${pass.name}/${fileBase(pathShape)}${suffix}`);
            chains.push(
              ...take(await pressables(page))
                .map((press) => [...chain, press])
                .reverse(),
            );
          });
          pages.add(state);
          if (last.valued) shot.add(last.id);
          console.info(`${state} ${pass.name} ${Date.now() - pressed}ms`);
        } catch (error) {
          console.info(
            `${state} ${pass.name} skipped (${String((error as Error)?.message || error).split("\n")[0]})`,
          );
          await replacePage();
        }
      }
    }
  }

  expect(pages.size, "the crawl captured no pages at all").toBeGreaterThan(0);
  writeFileSync("overlens-output/pages.txt", [...pages].sort().join("\n") + "\n");
});
