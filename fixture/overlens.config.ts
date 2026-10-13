import type { Page } from "@playwright/test";

export default {
  targetBranch: "main",
  passes: [
    { name: "desktop-light", width: 1280, theme: "light" },
    { name: "mobile-dark", width: 390, theme: "dark" },
  ],
  theme: (page: Page, theme: string) =>
    page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme),
};
