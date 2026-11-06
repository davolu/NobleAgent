import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noble } from "noble-agent";
import { tools } from "./tools.js";

// Config comes from one object; every field can also come from env
// (BOT_TYPE, COMPANY_NAME, SUPPORT_HOURS).
export const BOT = {
  type: process.env.BOT_TYPE ?? "support",
  company: process.env.COMPANY_NAME ?? "Acme Appliances",
  hours: process.env.SUPPORT_HOURS ?? "Mon-Fri 9:00-17:00 CET",
};

const here = dirname(fileURLToPath(import.meta.url));

// The acceptance example from the build plan (§7): preset + docs + tools.
export const bot = noble
  .preset(BOT.type, BOT)
  .docs(join(here, "..", "company-pdfs"))
  .tools(tools);
