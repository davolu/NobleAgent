import { defineConfig } from "vitepress";

export default defineConfig({
  title: "NobleAgent",
  description:
    "Customer-safe chat agents in a few chained lines — cited RAG, budgets, approvals built in.",
  base: "/NobleAgent/", // served at https://davolu.github.io/NobleAgent/
  ignoreDeadLinks: true, // some pages link into the repo tree
  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Strategies", link: "/strategies" },
      { text: "Adapters", link: "/adapters" },
      { text: "GitHub", link: "https://github.com/davolu/NobleAgent" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "API tour", link: "/api-tour" },
          { text: "Safety model", link: "/safety" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Strategies & costs", link: "/strategies" },
          { text: "Writing adapters", link: "/adapters" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/davolu/NobleAgent" }],
    search: { provider: "local" },
    footer: { message: "Released under the MIT License." },
  },
});
