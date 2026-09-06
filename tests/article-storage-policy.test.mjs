import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const mediaPaths = [
  "public/uploads/articles",
  "public/article-images",
  "public/scraped-article",
  "public/editorial-dispute-v1.png",
];
const placeholders = [
  "public/article-images/.gitkeep",
  "public/uploads/articles/.gitkeep",
];

function git(directory, args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" });
}

function trackedMedia(directory) {
  return git(directory, ["ls-files", "-z", "--", ...mediaPaths]).split("\0").filter(Boolean).sort();
}

test("article media and processing artifacts are absent from the Git index", () => {
  assert.deepEqual(trackedMedia(projectRoot), placeholders);
});

test("new article originals, outputs, previews and manifests stay ignored after git add", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "wangs-storage-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, ["init", "--quiet"]);
  await copyFile(path.join(projectRoot, ".gitignore"), path.join(directory, ".gitignore"));

  const articleId = "11111111-1111-4111-8111-111111111111";
  const generated = [
    `public/uploads/articles/${articleId}/raw.jpg`,
    `public/uploads/articles/${articleId}/original.webp`,
    `public/article-images/${articleId}/0123456789abcdef01234567.png`,
    `public/article-images/${articleId}/preview.png`,
    `public/article-images/${articleId}/manifest.json`,
    `public/article-images/${articleId}/regions.json`,
    `public/article-images/${articleId}/nested/preview.webp`,
    "public/scraped-article/article-image.png",
    "public/editorial-dispute-v1.png",
  ];
  const sourceAssets = ["public/favicon.png", "public/og.png", "public/file.svg"];
  for (const relative of [...generated, ...placeholders, ...sourceAssets]) {
    const filename = path.join(directory, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, "fixture");
  }
  const ignored = git(directory, ["check-ignore", "--no-index", "--", ...generated]).trim().split("\n").sort();
  assert.deepEqual(ignored, [...generated].sort());

  git(directory, ["add", "--all"]);
  assert.deepEqual(trackedMedia(directory), placeholders);
  const staged = git(directory, ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  assert.deepEqual(staged, [".gitignore", ...placeholders, ...sourceAssets].sort());
});
