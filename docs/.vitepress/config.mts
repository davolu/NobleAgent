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
      { text: "Reference", link: "/reference/entry-points" },
      { text: "Recipes", link: "/recipes/support-bot" },
      { text: "GitHub", link: "https://github.com/davolu/NobleAgent" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "API tour", link: "/api-tour" },
          { text: "Safety model", link: "/safety" },
          { text: "Strategies & costs", link: "/strategies" },
          { text: "Writing adapters", link: "/adapters" },
        ],
      },
      {
        text: "Recipes",
        items: [
          { text: "Support bot with refunds", link: "/recipes/support-bot" },
          { text: "Internal docs Q&A", link: "/recipes/docs-qa" },
          { text: "Research assistant", link: "/recipes/research-assistant" },
          { text: "Cost control at scale", link: "/recipes/cost-control" },
          { text: "Scheduled digest workflow", link: "/recipes/scheduled-digest" },
          { text: "MCP in both directions", link: "/recipes/mcp" },
        ],
      },
      {
        text: "API reference",
        items: [
          { text: "Entry points & presets", link: "/reference/entry-points" },
          { text: "Identity & models", link: "/reference/models" },
          { text: ".docs() — knowledge & RAG", link: "/reference/docs" },
          { text: ".tools() & .mcp()", link: "/reference/tools" },
          { text: ".memory()", link: "/reference/memory" },
          { text: ".promptEng() & reasoning", link: "/reference/prompting" },
          { text: ".budget(), .decide(), cost", link: "/reference/decisions" },
          { text: ".guard(), .approve(), hooks", link: "/reference/safety-api" },
          { text: ".observe() & events", link: "/reference/observability" },
          { text: ".durable(), .schedule(), workflows", link: "/reference/durability" },
          { text: ".evaluate(), pick-model, tune", link: "/reference/evaluation" },
          { text: "Execution: ask, stream, resume", link: "/reference/execution" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/davolu/NobleAgent" }],
    search: { provider: "local" },
    footer: { message: "Released under the MIT License." },
  },
});
