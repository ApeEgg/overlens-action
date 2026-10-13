import { writeFileSync } from "fs";

import { expect, test, type Page } from "@playwright/test";

import overlens from "../../overlens.config";

test.skip(!process.env.OVERLENS, "overlens crawl runs in CI only");
test.describe.configure({ retries: 0 });

const shape =
  overlens.shape ??
  ((path: string) => path.replace(/\/(?=[^/]*\d)[^/]{8,}/g, "/[id]"));
const mask = [
  '[data-overlens-mask=""], [data-overlens-mask="true"]',
  ...(overlens.mask ?? []),
];
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

const PAGE_DEADLINE = 90_000;
const withDeadline = <T>(work: () => Promise<T>) => {
  let timer: ReturnType<typeof setTimeout>;
  const working = work();
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

  if (overlens.auth) {
    const login = await context.newPage();
    await overlens.auth(login);
    await login.close();
  }

  let page = await context.newPage();
  await preparePage(page);

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

  const entryOf = new Map(
    entries.map((u) => [u.pathname.replace(/\/$/, "") || "/", u.href]),
  );
  const seen = new Set<string>();
  const queue = [...entryOf.keys()];
  const pages = new Set<string>();
  const shotOf = new Map<Pass, Set<string>>();

  while (queue.length) {
    const path = queue.shift()!.replace(/\/$/, "") || "/";
    if (seen.has(path)) continue;
    seen.add(path);
    if (excluded(path)) continue;
    const pathShape = shape(path);
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
