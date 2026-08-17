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

const tokens = [
  ...new Set([
    new URL(overlens.firstPageToVisit).host,
    new URL(process.env.PLAYWRIGHT_BASE_URL ?? overlens.firstPageToVisit).host,
  ]),
]
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
// fetches goto never saw. Quiescence is observed directly — no network event
// and no DOM mutation for 400ms, capped at 10s so a page that never goes quiet
// is shot as-is, masks covering its known tickers.
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

// A page can wedge its own main thread (an app bug: an infinite render/
// navigate loop). Playwright's evaluate has no timeout, so without a deadline
// one broken page hangs the whole crawl silently until CI kills it. The
// deadline covers everything legitimate (goto 30s + ready + four passes on a
// slow runner); a page that busts it is unusable — no CDP call will ever
// return — so the crawl closes it and continues on a fresh one.
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

  let page = await context.newPage();
  await preparePage(page);

  await overlens.auth?.(page);

  const first = new URL(overlens.firstPageToVisit);
  const firstPath = first.pathname.replace(/\/$/, "") || "/";
  const seen = new Set<string>();
  const queue = [firstPath];
  const pages: string[] = [];

  while (queue.length) {
    const path = queue.shift()!.replace(/\/$/, "") || "/";
    if (seen.has(path)) continue;
    seen.add(path);
    const pathShape = shape(path);
    // `shape` declares these paths to be the same page, so a second instance
    // has nothing to add: same screenshot, same links. Collapsing them is the
    // whole point of shaping. A shape only counts as captured once a visit
    // succeeds, so a page that fails still lets its siblings stand in.
    if (pages.includes(pathShape)) continue;
    const started = Date.now();

    try {
      await withDeadline(async () => {
        await page.goto(
          path === firstPath ? first.href : `${first.origin}${path}`,
          {
            waitUntil: "networkidle",
            timeout: 30000,
          },
        );
        await overlens.ready?.(page);

        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({
          content:
            "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }",
        });

        for (const { name, width, theme } of overlens.passes) {
          await page.setViewportSize({ width, height: 720 });
          await overlens.theme(page, theme);
          await normalize(page);
          await settled(page);
          await page.evaluate(() =>
            Promise.all(
              [...document.images].map((img) => img.decode().catch(() => {})),
            ),
          );
          await page.screenshot({
            path: `overlens-output/${name}/${fileBase(pathShape)}.png`,
            fullPage: true,
            mask: mask.map((selector) => page.locator(selector)),
          });
        }
        const hrefs = await page
          .locator("a[href^='/']:not([href^='//'])")
          .evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
        queue.push(...hrefs.map((href) => href.split(/[?#]/)[0]));
        pages.push(pathShape);
      });
      console.info(
        `${pathShape} ${Date.now() - started}ms (visited ${seen.size}, queued ${queue.length})`,
      );
    } catch (error) {
      console.info(
        `${pathShape} skipped (${String((error as Error)?.message || error).split("\n")[0]})`,
      );
      // The page may be wedged beyond recovery — replace it. Cookies and
      // storage live on the context, so the session carries over.
      await page.close().catch(() => {});
      page = await context.newPage();
      await preparePage(page);
    }
  }

  expect(pages.length, "the crawl captured no pages at all").toBeGreaterThan(0);
  writeFileSync("overlens-output/pages.txt", pages.sort().join("\n") + "\n");
});
