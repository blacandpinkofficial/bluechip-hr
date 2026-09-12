// lib/prisma.js — one client, reused.
//
// Next's dev server reloads modules on every edit; without the global cache
// each reload opens a fresh connection pool until Postgres refuses new
// connections. The Pulse box runs one Postgres for two applications now, so
// leaking connections here would degrade the retail app, not just this one.

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__bluechipPrisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__bluechipPrisma = prisma;
}

export default prisma;
