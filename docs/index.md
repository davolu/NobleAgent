---
layout: home

hero:
  name: NobleAgent
  text: Customer-safe chat agents in a few chained lines
  tagline: Cited RAG, hard budgets, human-in-the-loop approvals — short chains, smart defaults, full control when needed.
  actions:
    - theme: brand
      text: Getting started
      link: /getting-started
    - theme: alt
      text: Recipes
      link: /recipes/support-bot
    - theme: alt
      text: API reference
      link: /reference/entry-points

features:
  - icon: ⛓️
    title: Short chains, smart defaults
    details: A 3-line bot already has durable memory, hybrid RAG with page citations, a cost budget and tracing. Override any of it one chain link at a time.
  - icon: 🔍
    title: Nothing is a black box
    details: bot.explain() prints every resolved setting and its source — preset, env, convention, or your code.
  - icon: 🛡️
    title: Unsafe things are never inferred
    details: Side-effect tools pause for human approval. Retrieved docs live in an untrusted data channel. Access control runs in code, never in prompts.
  - icon: 💸
    title: Hard limits beat smart policies
    details: Budgets are enforced by the loop before any model call — no routing policy or reasoning strategy can spend past them.
  - icon: 🧩
    title: Everything is an adapter
    details: Models, memory, vector stores, strategies, sinks and deciders share one small interface each. Swap Anthropic for OpenAI, SQLite for Postgres, in one line.
  - icon: 📏
    title: Honest strategies
    details: Every RAG and prompting strategy declares its cost multiplier. Anything ≥2× refuses to run without an explicit budget.
---
