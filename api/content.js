const crypto = require("crypto");

const OWNER = "ParkSungwoo119";
const REPO = "sunhancare";
const FILE_PATH = "data/content.json";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function cleanText(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, max);
}

function cleanDate(value) {
  const text = cleanText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalize(data) {
  const source = data && typeof data === "object" ? data : {};
  const notices = Array.isArray(source.notices) ? source.notices : [];
  const schedules = Array.isArray(source.schedules) ? source.schedules : [];
  return {
    notices: notices
      .map(function (item) {
        const title = cleanText(item && item.title, 80);
        if (!title) return null;
        return {
          id: cleanText(item.id, 40) || newId(),
          title: title,
          body: cleanText(item.body, 1000),
          date: cleanDate(item.date)
        };
      })
      .filter(Boolean)
      .slice(0, 30),
    schedules: schedules
      .map(function (item) {
        const title = cleanText(item && item.title, 80);
        if (!title) return null;
        return {
          id: cleanText(item.id, 40) || newId(),
          title: title,
          when: cleanText(item.when, 80),
          body: cleanText(item.body, 1000),
          date: cleanDate(item.date)
        };
      })
      .filter(Boolean)
      .slice(0, 30)
  };
}

function passwordOk(input) {
  const secret = process.env.ADMIN_PASSWORD || "";
  if (!secret || !input) return false;
  const a = crypto.createHash("sha256").update(String(input)).digest();
  const b = crypto.createHash("sha256").update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "sunhancare-admin",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  return headers;
}

async function readGithub() {
  const response = await fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + FILE_PATH + "?ref=main", {
    headers: githubHeaders()
  });
  if (response.status === 404) return { content: { notices: [], schedules: [] }, sha: "" };
  if (!response.ok) throw new Error("github-read-" + response.status);
  const payload = await response.json();
  const text = Buffer.from(payload.content || "", "base64").toString("utf8");
  return { content: normalize(JSON.parse(text || "{}")), sha: payload.sha || "" };
}

async function writeGithub(content, sha) {
  const response = await fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + FILE_PATH, {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, githubHeaders()),
    body: JSON.stringify({
      message: "Update homepage notices and class schedule",
      content: Buffer.from(JSON.stringify(content, null, 2) + "\n").toString("base64"),
      sha: sha || undefined,
      branch: "main"
    })
  });
  if (!response.ok) throw new Error("github-write-" + response.status);
}

function readLocal() {
  const fs = require("fs");
  const path = require("path");
  const file = path.join(process.cwd(), FILE_PATH);
  if (!fs.existsSync(file)) return { notices: [], schedules: [] };
  return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
}

function writeLocal(content) {
  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(path.join(process.cwd(), FILE_PATH), JSON.stringify(content, null, 2) + "\n");
}

async function readContent() {
  if (process.env.GITHUB_TOKEN) return readGithub();
  if (process.env.VERCEL) {
    try { return await readGithub(); } catch (error) { return { content: readLocal(), sha: "" }; }
  }
  return { content: readLocal(), sha: "" };
}

async function writeContent(content, sha) {
  if (process.env.GITHUB_TOKEN || process.env.VERCEL) {
    await writeGithub(content, sha);
    return;
  }
  writeLocal(content);
}

function applyAction(content, body) {
  const action = body.action;
  if (action === "login") return { content: content };
  if (action === "add-notice") {
    const title = cleanText(body.title, 80);
    if (!title) return { error: "공지 제목을 입력해 주세요." };
    content.notices.unshift({
      id: newId(),
      title: title,
      body: cleanText(body.body, 1000),
      date: cleanDate(body.date)
    });
    content.notices = content.notices.slice(0, 30);
    return { content: content };
  }
  if (action === "delete-notice") {
    content.notices = content.notices.filter(function (item) { return item.id !== cleanText(body.id, 40); });
    return { content: content };
  }
  if (action === "add-schedule") {
    const title = cleanText(body.title, 80);
    if (!title) return { error: "일정 제목을 입력해 주세요." };
    content.schedules.unshift({
      id: newId(),
      title: title,
      when: cleanText(body.when, 80),
      body: cleanText(body.body, 1000),
      date: cleanDate(body.date)
    });
    content.schedules = content.schedules.slice(0, 30);
    return { content: content };
  }
  if (action === "delete-schedule") {
    content.schedules = content.schedules.filter(function (item) { return item.id !== cleanText(body.id, 40); });
    return { content: content };
  }
  return { error: "요청을 처리할 수 없습니다." };
}

async function readRequestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) return JSON.parse(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const stored = await readContent();
      send(res, 200, stored.content);
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "허용되지 않은 요청입니다." });
      return;
    }
    const body = await readRequestBody(req);
    if (!passwordOk(body.password)) {
      send(res, 401, { error: "비밀번호가 맞지 않습니다." });
      return;
    }
    const stored = await readContent();
    const result = applyAction(stored.content, body);
    if (result.error) {
      send(res, 400, { error: result.error });
      return;
    }
    await writeContent(result.content, stored.sha);
    send(res, 200, result.content);
  } catch (error) {
    console.error(error && error.message ? error.message : "content-api-error");
    send(res, 500, { error: "저장 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요." });
  }
};
