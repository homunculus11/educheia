const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT_DIR = process.cwd();
const IMAGES_DIR = path.join(ROOT_DIR, 'images');

const JOBS = [
  {
    input: 'logo-light.webp',
    outputs: [
      { suffix: 'h54', resize: { height: 54 }, quality: 88 },
      { suffix: 'h64', resize: { height: 64 }, quality: 88 },
      { suffix: 'h108', resize: { height: 108 }, quality: 88 },
      { suffix: 'h128', resize: { height: 128 }, quality: 88 },
    ],
  },
  {
    input: 'logo-dark.webp',
    outputs: [
      { suffix: 'h54', resize: { height: 54 }, quality: 88 },
      { suffix: 'h64', resize: { height: 64 }, quality: 88 },
      { suffix: 'h108', resize: { height: 108 }, quality: 88 },
      { suffix: 'h128', resize: { height: 128 }, quality: 88 },
    ],
  },
  {
    input: 'hero.webp',
    outputs: [
      { suffix: 'w480', resize: { width: 480 }, quality: 86 },
      { suffix: 'w960', resize: { width: 960 }, quality: 86 },
    ],
  },
  {
    input: 'viorel-cozma.webp',
    outputs: [
      {
        suffix: 'avatar-56',
        resize: { width: 56, height: 56, fit: 'cover', position: 'attention' },
        quality: 84,
      },
      {
        suffix: 'avatar-112',
        resize: { width: 112, height: 112, fit: 'cover', position: 'attention' },
        quality: 84,
      },
    ],
  },
  {
    input: 'oleg-groian.webp',
    outputs: [
      {
        suffix: 'avatar-56',
        resize: { width: 56, height: 56, fit: 'cover', position: 'attention' },
        quality: 84,
      },
      {
        suffix: 'avatar-112',
        resize: { width: 112, height: 112, fit: 'cover', position: 'attention' },
        quality: 84,
      },
    ],
  },
  {
    input: 'laura-turcan.webp',
    outputs: [
      {
        suffix: 'avatar-56',
        resize: { width: 56, height: 56, fit: 'cover', position: 'attention' },
        quality: 84,
      },
      {
        suffix: 'avatar-112',
        resize: { width: 112, height: 112, fit: 'cover', position: 'attention' },
        quality: 84,
      },
    ],
  },
  {
    input: 'andrei-aparatu.webp',
    outputs: [
      {
        suffix: 'avatar-56',
        resize: { width: 56, height: 56, fit: 'cover', position: 'attention' },
        quality: 84,
      },
      {
        suffix: 'avatar-112',
        resize: { width: 112, height: 112, fit: 'cover', position: 'attention' },
        quality: 84,
      },
    ],
  },
  {
    input: 'vlad-milea.webp',
    outputs: [
      {
        suffix: 'avatar-56',
        resize: { width: 56, height: 56, fit: 'cover', position: 'attention' },
        quality: 84,
      },
      {
        suffix: 'avatar-112',
        resize: { width: 112, height: 112, fit: 'cover', position: 'attention' },
        quality: 84,
      },
    ],
  },
  {
    input: 'elena-anghel.webp',
    outputs: [
      {
        suffix: 'avatar-56',
        resize: { width: 56, height: 56, fit: 'cover', position: 'attention' },
        quality: 84,
      },
      {
        suffix: 'avatar-112',
        resize: { width: 112, height: 112, fit: 'cover', position: 'attention' },
        quality: 84,
      },
    ],
  },
];

const toOutputPath = (inputName, suffix) => {
  const parsed = path.parse(inputName);
  return path.join(IMAGES_DIR, `${parsed.name}-${suffix}.webp`);
};

async function buildOutput(inputPath, outputPath, outputConfig) {
  const transformer = sharp(inputPath).rotate().resize(outputConfig.resize);

  await transformer.webp({ quality: outputConfig.quality, effort: 5 }).toFile(outputPath);
}

async function run() {
  const created = [];

  for (const job of JOBS) {
    const inputPath = path.join(IMAGES_DIR, job.input);
    if (!fs.existsSync(inputPath)) {
      console.warn(`Skipping missing source image: ${job.input}`);
      continue;
    }

    for (const output of job.outputs) {
      const outputPath = toOutputPath(job.input, output.suffix);
      await buildOutput(inputPath, outputPath, output);
      created.push(path.relative(ROOT_DIR, outputPath));
    }
  }

  console.log(`Generated ${created.length} responsive image file(s).`);
  for (const filePath of created) {
    console.log(`- ${filePath.replace(/\\/g, '/')}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
