"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const {
  log,
  warn,
  error,
  info,
  divider,
  elapsed,
  bytes,
  summary,
  c,
  B,
  D,
  GRN,
  YLW,
  CYN,
  R,
} = require("./_logger.cjs");

// ── Config ───────────────────────────────────────────────────────────────────
const ROOT_DIR = process.cwd();
const IMAGES_DIR = path.join(ROOT_DIR, "images");
const CONCURRENCY = 4; // parallel sharp jobs

const FORCE = process.argv.includes("--force");

// ── Job definitions ──────────────────────────────────────────────────────────
const JOBS = [
  {
    input: "logo-light.webp",
    outputs: [
      { suffix: "h54", resize: { height: 54 }, quality: 88 },
      { suffix: "h64", resize: { height: 64 }, quality: 88 },
      { suffix: "h108", resize: { height: 108 }, quality: 88 },
      { suffix: "h128", resize: { height: 128 }, quality: 88 },
    ],
  },
  {
    input: "logo-dark.webp",
    outputs: [
      { suffix: "h54", resize: { height: 54 }, quality: 88 },
      { suffix: "h64", resize: { height: 64 }, quality: 88 },
      { suffix: "h108", resize: { height: 108 }, quality: 88 },
      { suffix: "h128", resize: { height: 128 }, quality: 88 },
    ],
  },
  {
    input: "hero.webp",
    outputs: [
      { suffix: "w480", resize: { width: 480 }, quality: 86 },
      { suffix: "w960", resize: { width: 960 }, quality: 86 },
    ],
  },
  // ── Avatars (56 + @2x 112) ─────────────────────────────────────────────────
  ...[
    "viorel-cozma",
    "oleg-groian",
    "laura-turcan",
    "andrei-aparatu",
    "vlad-milea",
    "elena-anghel",
  ].map((name) => ({
    input: `${name}.webp`,
    outputs: [
      {
        suffix: "avatar-56",
        resize: { width: 56, height: 56, fit: "cover", position: "attention" },
        quality: 84,
      },
      {
        suffix: "avatar-112",
        resize: {
          width: 112,
          height: 112,
          fit: "cover",
          position: "attention",
        },
        quality: 84,
      },
    ],
  })),
];

// ── Helpers ──────────────────────────────────────────────────────────────────
const toOutputPath = (inputName, suffix) => {
  const { name } = path.parse(inputName);
  return path.join(IMAGES_DIR, `${name}-${suffix}.webp`);
};

/** Returns true when the output file exists and is newer than the source. */
function isFresh(inputPath, outputPath) {
  if (!fs.existsSync(outputPath)) return false;
  return fs.statSync(outputPath).mtimeMs >= fs.statSync(inputPath).mtimeMs;
}

async function processOutput(inputPath, outputPath, cfg) {
  await sharp(inputPath)
    .rotate()
    .resize(cfg.resize)
    .webp({ quality: cfg.quality, effort: 5 })
    .toFile(outputPath);
}

// Simple async concurrency pool
async function runPool(tasks, concurrency) {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      await tasks[i++]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  divider("Responsive Images");
  if (FORCE) info("--force: regenerating all outputs");

  // Flatten all jobs into individual tasks
  const tasks = [];
  let skippedN = 0;
  let missingN = 0;

  for (const job of JOBS) {
    const inputPath = path.join(IMAGES_DIR, job.input);

    if (!fs.existsSync(inputPath)) {
      warn(`Source not found — skipping: ${job.input}`);
      missingN++;
      continue;
    }

    for (const out of job.outputs) {
      const outputPath = toOutputPath(job.input, out.suffix);

      if (!FORCE && isFresh(inputPath, outputPath)) {
        skippedN++;
        continue;
      }

      tasks.push(async () => {
        const tFile = Date.now();
        await processOutput(inputPath, outputPath, out);
        const size = fs.statSync(outputPath).size;
        const rel = path.relative(ROOT_DIR, outputPath).replace(/\\/g, "/");
        console.log(
          `  ${c(GRN, "+")}  ${c(D, rel)}  ${c(CYN, bytes(size))}  ${c(D, elapsed(tFile))}`,
        );
      });
    }
  }

  if (tasks.length === 0 && skippedN > 0) {
    log(`All ${skippedN} output(s) are up to date — nothing to do`);
    info("Use --force to regenerate anyway");
    return;
  }

  info(
    `Generating ${c(B, String(tasks.length))} image(s)  ·  concurrency ${c(B, String(Math.min(CONCURRENCY, tasks.length)))}`,
  );
  if (skippedN > 0)
    info(`Skipping ${skippedN} up-to-date output(s) (use --force to override)`);

  await runPool(tasks, CONCURRENCY);

  console.log();
  summary([
    ["Generated", String(tasks.length)],
    ["Skipped", `${skippedN} (up to date)`],
    ["Missing src", `${missingN}`],
    ["Duration", elapsed(t0)],
  ]);
  console.log();
}

run().catch((e) => {
  error(e.message || String(e));
  process.exit(1);
});
