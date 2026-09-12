// scripts/seed-owner.mjs — create the first account.
//
//   node scripts/seed-owner.mjs "Name" email@example.com
//
// It prints a generated password ONCE and never stores it in plain text. There
// is deliberately no default password: a known default that someone forgets to
// change is how an HR database with every candidate's phone number ends up
// public.
//
// Safe to run again — it will refuse to overwrite an existing account.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const prisma = new PrismaClient();

const [, , nameArg, emailArg] = process.argv;

if (!nameArg || !emailArg) {
  console.error('Usage: node scripts/seed-owner.mjs "Full Name" email@example.com');
  process.exit(1);
}

const name = nameArg.trim();
const email = emailArg.trim().toLowerCase();

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`"${email}" does not look like an email address.`);
  process.exit(1);
}

function generatePassword() {
  // Avoids look-alike characters, because this gets read aloud or typed from a
  // screenshot at least once.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(16))
    .map((b) => alphabet[b % alphabet.length])
    .join("");
}

try {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`An account already exists for ${email} (role: ${existing.role}).`);
    console.error("To reset its password, use the user admin screen — this script will not overwrite.");
    process.exit(1);
  }

  const password = generatePassword();
  const user = await prisma.user.create({
    data: {
      name,
      email,
      role: "owner",
      passwordHash: await bcrypt.hash(password, 10),
      active: true,
    },
  });

  console.log("");
  console.log("  Owner account created");
  console.log("  ─────────────────────");
  console.log(`  Name      ${user.name}`);
  console.log(`  Email     ${user.email}`);
  console.log(`  Password  ${password}`);
  console.log("");
  console.log("  This password is shown once and is not recoverable.");
  console.log("  Send it over a channel you trust, and change it after first sign-in.");
  console.log("");
} catch (e) {
  console.error("Failed:", e?.message || e);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
