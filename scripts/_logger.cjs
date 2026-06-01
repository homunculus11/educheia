"use strict";

// ── ANSI codes (disabled when not a real terminal) ──────────────────────────
const isTTY = process.stdout.isTTY !== false;
const c = (codes, s) => (isTTY ? `${codes}${s}\x1b[0m` : s);

const R = isTTY ? "\x1b[0m" : "";
const B = isTTY ? "\x1b[1m" : "";
const D = isTTY ? "\x1b[2m" : "";
const RED = isTTY ? "\x1b[31m" : "";
const GRN = isTTY ? "\x1b[32m" : "";
const YLW = isTTY ? "\x1b[33m" : "";
const BLU = isTTY ? "\x1b[34m" : "";
const MGT = isTTY ? "\x1b[35m" : "";
const CYN = isTTY ? "\x1b[36m" : "";

// ── Helpers ──────────────────────────────────────────────────────────────────
const ts = () => c(D, new Date().toTimeString().slice(0, 8));

const log = (msg) => console.log(`${ts()}  ${c(GRN, "✔")}  ${msg}`);
const warn = (msg) => console.warn(`${ts()}  ${c(YLW, "⚠")}  ${msg}`);
const error = (msg) => console.error(`${ts()}  ${c(RED, "✖")}  ${msg}`);
const info = (msg) => console.log(`${ts()}  ${c(CYN, "➜")}  ${msg}`);

const step = (n, total, title) =>
  console.log(`\n${c(B + CYN, `Step ${n}/${total}`)}  ${c(B, title)}`);

const divider = (title = "") => {
  const W = 56;
  if (!title) {
    console.log(`\n${c(CYN, "─".repeat(W))}`);
    return;
  }
  const pad = Math.max(0, W - title.length - 2);
  const l = Math.floor(pad / 2);
  console.log(
    `\n${c(CYN, "─".repeat(l))} ${c(B, title)} ${c(CYN, "─".repeat(pad - l))}`,
  );
};

const elapsed = (startMs) => {
  const d = Date.now() - startMs;
  return (
    d >= 60_000 ?
      `${Math.floor(d / 60_000)}m ${Math.round((d % 60_000) / 1000)}s`
    : d >= 1000 ? `${(d / 1000).toFixed(2)}s`
    : `${d}ms`
  );
};

const bytes = (n) =>
  n < 1024 ? `${n} B`
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB`
  : `${(n / 1024 ** 2).toFixed(2)} MB`;

// Pretty two-column summary table
const summary = (rows) => {
  const W = Math.max(...rows.map(([k]) => k.length));
  console.log();
  for (const [k, v] of rows) {
    console.log(`  ${c(D, k.padEnd(W))}  ${v}`);
  }
};

module.exports = {
  log,
  warn,
  error,
  info,
  step,
  divider,
  elapsed,
  bytes,
  summary,
  ts,
  c,
  R,
  B,
  D,
  RED,
  GRN,
  YLW,
  BLU,
  MGT,
  CYN,
};
