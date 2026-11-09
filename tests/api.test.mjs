import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
const base = process.env.API_URL || "http://127.0.0.1:9261";
let token = "";
async function request(path, method = "GET", body, status = 200, auth = token) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: "Bearer " + auth } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = r.status === 204 ? null : await r.json();
  assert.equal(r.status, status, JSON.stringify(data));
  return data;
}
async function waitJob(id) {
  for (let i = 0; i < 180; i++) {
    const j = await request("/jobs/" + id);
    if (["completed", "failed", "cancelled"].includes(j.state)) {
      assert.equal(j.state, "completed", JSON.stringify(j));
      return j;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Job timed out");
}
test("real media workflow, revisions, permissions and immutable render", async () => {
  const login = await request("/login", "POST", {
    username: "berkay",
    password: process.env.TEST_PASSWORD || "Framelab2026!",
  });
  token = login.token;
  await request("/projects", "GET", undefined, 401, "");
  const p = await request("/projects/demo", "POST");
  let b = await request("/projects/" + p.id);
  await waitJob(b.jobs[0].id);
  b = await request("/projects/" + p.id);
  assert.equal(b.assets.length, 2);
  assert.ok(b.assets.every((a) => a.state === "ready"));
  assert.equal(b.project.document.clips.length, 2);
  const doc = structuredClone(b.project.document);
  doc.clips[0].title = '100% réel : "FrameLab"';
  doc.clips[0].out = 1.5;
  doc.clips[1].out = 1.5;
  const saved = await request("/projects/" + p.id, "PUT", {
    name: "Integration film",
    revision: b.project.revision,
    document: doc,
  });
  await request(
    "/projects/" + p.id,
    "PUT",
    { name: "stale", revision: b.project.revision, document: doc },
    409,
  );
  b = await request("/projects/" + p.id);
  const renderBody = {
    key: crypto.randomUUID(),
    revision: b.project.revision,
    preset: "720p",
  };
  const j = await request("/projects/" + p.id + "/renders", "POST", renderBody);
  const same = await request(
    "/projects/" + p.id + "/renders",
    "POST",
    renderBody,
  );
  assert.equal(j.id, same.id);
  const changed = structuredClone(doc);
  changed.clips[0].title = "Later version";
  await request("/projects/" + p.id, "PUT", {
    name: "Integration film updated",
    revision: b.project.revision,
    document: changed,
  });
  const done = await waitJob(j.id);
  assert.ok(done.download);
  const output = await fetch(base + done.download, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(output.status, 200);
  const bytes = Buffer.from(await output.arrayBuffer());
  assert.ok(bytes.length > 10000);
  await mkdir(".runtime/test-results", { recursive: true });
  await writeFile(".runtime/test-results/render.mp4", bytes);
  const range = await fetch(base + done.download, {
    headers: { Authorization: "Bearer " + token, Range: "bytes=0-99" },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  const viewer = await request("/login", "POST", {
    username: "deniz",
    password: process.env.TEST_PASSWORD || "Framelab2026!",
  });
  await request("/projects/" + p.id, "GET", undefined, 404, viewer.token);
  await request(
    "/projects/" + p.id + "/members",
    "POST",
    { username: "deniz", role: "viewer" },
    204,
  );
  await request("/projects/" + p.id, "GET", undefined, 200, viewer.token);
  await request(
    "/projects/" + p.id,
    "PUT",
    { name: "forbidden", revision: 3, document: doc },
    403,
    viewer.token,
  );
  await request(
    "/projects/" + p.id + "/comments",
    "POST",
    { text: "At this frame", at: 0.5 },
    200,
    viewer.token,
  );
  await request("/logout", "POST", undefined, 204, viewer.token);
  await request("/me", "GET", undefined, 401, viewer.token);
  console.log("Verified real MP4:", bytes.length, "bytes; project:", p.id);
});

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
test("resumable upload verifies duplicate chunks and rejects corrupted bodies", async () => {
  const login = await request("/login", "POST", {
    username: "berkay",
    password: process.env.TEST_PASSWORD || "Framelab2026!",
  });
  token = login.token;
  const p = await request("/projects", "POST", { name: "Upload test" });
  const bytes = await readFile(".runtime/test-results/render.mp4");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const input = {
    name: "fixture.mp4",
    total: bytes.length,
    hash,
    key: crypto.randomUUID(),
  };
  const u = await request("/projects/" + p.id + "/uploads", "POST", input);
  assert.equal(
    (await request("/projects/" + p.id + "/uploads", "POST", input)).id,
    u.id,
  );
  async function chunk(offset, data, status = 200) {
    const r = await fetch(base + "/api/uploads/" + u.id + "?offset=" + offset, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    assert.equal(r.status, status, await r.text());
  }
  const middle = Math.floor(bytes.length / 2);
  await chunk(0, bytes.subarray(0, middle));
  await chunk(0, bytes.subarray(0, middle));
  await chunk(0, Buffer.alloc(middle), 409);
  assert.equal((await request("/uploads/" + u.id)).received, middle);
  await chunk(middle + 1, bytes.subarray(middle + 1), 409);
  await chunk(middle, bytes.subarray(middle));
  const a = await request("/uploads/" + u.id + "/complete", "POST");
  assert.equal(
    (await request("/uploads/" + u.id + "/complete", "POST")).assetId,
    a.assetId,
  );
  let b = await request("/projects/" + p.id);
  await waitJob(b.jobs[0].id);
  b = await request("/projects/" + p.id);
  assert.equal(b.assets[0].state, "ready");
  const doc = {
    format: "portrait",
    clips: [
      {
        id: crypto.randomUUID(),
        assetId: a.assetId,
        in: 0,
        out: 0.6,
        volume: 1,
        muted: false,
        title: "Portrait",
        titleSize: 56,
        titlePosition: "center",
        transition: "cut",
      },
    ],
    musicId: null,
    musicVolume: 0.2,
  };
  await request("/projects/" + p.id, "PUT", {
    name: "Portrait",
    revision: b.project.revision,
    document: doc,
  });
  b = await request("/projects/" + p.id);
  const j = await request("/projects/" + p.id + "/renders", "POST", {
    key: crypto.randomUUID(),
    revision: b.project.revision,
    preset: "1080p",
  });
  const done = await waitJob(j.id);
  const r = await fetch(base + done.download, {
    headers: { Authorization: "Bearer " + token },
  });
  await writeFile(
    ".runtime/test-results/portrait.mp4",
    Buffer.from(await r.arrayBuffer()),
  );
  const bad = await request("/projects/" + p.id + "/uploads", "POST", {
    name: "corrupt.mp4",
    total: 4,
    hash: "0".repeat(64),
    key: crypto.randomUUID(),
  });
  await fetch(base + "/api/uploads/" + bad.id + "?offset=0", {
    method: "PUT",
    headers: { Authorization: "Bearer " + token },
    body: Buffer.from("nope"),
  });
  await request("/uploads/" + bad.id + "/complete", "POST", undefined, 422);
});

import { execFileSync } from "node:child_process";
test("audio music mix, cancellation and retry produce a playable output", async () => {
  const list = await request("/projects");
  const p = list.find((p) => p.name === "Portrait");
  assert.ok(p);
  execFileSync(process.env.FFmpegPath || "ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:a",
    "pcm_s16le",
    ".runtime/test-results/music.wav",
  ]);
  const bytes = await readFile(".runtime/test-results/music.wav");
  const upload = await request("/projects/" + p.id + "/uploads", "POST", {
    name: "music.wav",
    total: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
    key: crypto.randomUUID(),
  });
  const part = await fetch(base + "/api/uploads/" + upload.id + "?offset=0", {
    method: "PUT",
    headers: { Authorization: "Bearer " + token },
    body: bytes,
  });
  assert.equal(part.status, 200);
  const asset = await request("/uploads/" + upload.id + "/complete", "POST");
  let b = await request("/projects/" + p.id);
  await waitJob(
    b.jobs.find((j) => j.kind === "ingest" && j.state !== "completed").id,
  );
  b = await request("/projects/" + p.id);
  assert.equal(b.assets.find((a) => a.id === asset.assetId).kind, "audio");
  assert.ok(b.assets.find((a) => a.id === asset.assetId).wave);
  const doc = structuredClone(b.project.document);
  doc.format = "landscape";
  doc.musicId = asset.assetId;
  doc.clips = Array.from({ length: 4 }, () => ({
    ...doc.clips[0],
    id: crypto.randomUUID(),
    out: 3,
  }));
  await request("/projects/" + p.id, "PUT", {
    name: "Music mix",
    revision: b.project.revision,
    document: doc,
  });
  b = await request("/projects/" + p.id);
  const j = await request("/projects/" + p.id + "/renders", "POST", {
    key: crypto.randomUUID(),
    revision: b.project.revision,
    preset: "720p",
  });
  await request("/jobs/" + j.id + "/cancel", "POST", undefined, 204);
  let cancelled;
  for (let i = 0; i < 40; i++) {
    cancelled = await request("/jobs/" + j.id);
    if (cancelled.state === "cancelled") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(cancelled.state, "cancelled");
  const retry = await request("/jobs/" + j.id + "/retry", "POST");
  assert.notEqual(retry.id, j.id);
  await waitJob(retry.id);
  console.log("Verified music mix, waveform, cancellation and retry");
});
