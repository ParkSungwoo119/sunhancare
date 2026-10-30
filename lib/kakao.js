const crypto = require("crypto");

const OWNER = "ParkSungwoo119";
const REPO = "sunhancare";
const FILE_PATH = "data/kakao.json";
const REDIRECT_URI = "https://sunhancare.vercel.app/api/kakao";
const SITE = "https://sunhancare.vercel.app/";
const COURSES = ["주간반", "야간반", "주말반", "자격면허 소지자반", "보수교육", "아직 잘 모르겠어요"];

function cleanText(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, max);
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
    "User-Agent": "sunhancare-inquiry",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  return headers;
}

function storeKey() {
  const secret = process.env.KAKAO_STORE_KEY || "";
  if (secret.length < 16) return null;
  return crypto.createHash("sha256").update(secret).digest();
}

function seal(payload) {
  const key = storeKey();
  if (!key) throw new Error("store-key");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  };
}

function open(box) {
  const key = storeKey();
  if (!key || !box || !box.iv || !box.tag || !box.data) return {};
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const text = Buffer.concat([
    decipher.update(Buffer.from(box.data, "base64")),
    decipher.final()
  ]).toString("utf8");
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : {};
}

async function readBox() {
  if (!process.env.GITHUB_TOKEN) return { secrets: {}, sha: "" };
  const response = await fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + FILE_PATH + "?ref=main", {
    headers: githubHeaders()
  });
  if (response.status === 404) return { secrets: {}, sha: "" };
  if (!response.ok) throw new Error("github-read-" + response.status);
  const payload = await response.json();
  const text = Buffer.from(payload.content || "", "base64").toString("utf8");
  return { secrets: open(JSON.parse(text || "{}")), sha: payload.sha || "" };
}

async function writeBox(secrets, sha) {
  if (!process.env.GITHUB_TOKEN) throw new Error("github-token");
  const response = await fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + FILE_PATH, {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, githubHeaders()),
    body: JSON.stringify({
      message: "Store the Kakao inquiry connection",
      content: Buffer.from(JSON.stringify(seal(secrets)) + "\n").toString("base64"),
      sha: sha || undefined,
      branch: "main"
    })
  });
  if (!response.ok) throw new Error("github-write-" + response.status);
}

function checkInquiry(body) {
  const name = cleanText(body && body.name, 40);
  const phone = cleanText(body && body.phone, 20);
  const course = cleanText(body && body.course, 40);
  const message = cleanText(body && body.message, 800);
  const digits = phone.replace(/\D/g, "");
  if (!name) return { error: "성함을 입력해 주세요." };
  if (digits.length < 9) return { error: "연락처를 입력해 주세요." };
  if (COURSES.indexOf(course) === -1) return { error: "관심 과정을 선택해 주세요." };
  if (!message) return { error: "문의 내용을 입력해 주세요." };
  if (!body || body.consent !== true) return { error: "이름과 전화번호 확인에 동의해 주세요." };
  return { inquiry: { name: name, phone: phone, course: course, message: message } };
}

function buildMessages(inquiry) {
  const text = [
    "[수강 문의]",
    "성함: " + inquiry.name,
    "연락처: " + inquiry.phone,
    "과정: " + inquiry.course,
    "내용: " + inquiry.message
  ].join("\n");
  const raw = [];
  for (let index = 0; index < text.length; index += 150) raw.push(text.slice(index, index + 150));
  if (raw.length === 1) return [text.slice(0, 200)];
  return raw.map(function (part, index) {
    return ("(" + (index + 1) + "/" + raw.length + ") " + part).slice(0, 200);
  });
}

function makeState() {
  const stamp = String(Date.now());
  const mac = crypto.createHmac("sha256", process.env.ADMIN_PASSWORD || "").update(stamp).digest("base64url");
  return stamp + "." + mac;
}

function checkState(state) {
  const parts = String(state || "").split(".");
  if (parts.length !== 2 || !process.env.ADMIN_PASSWORD) return false;
  const stamp = Number(parts[0]);
  if (!stamp || Math.abs(Date.now() - stamp) > 10 * 60 * 1000) return false;
  const mac = crypto.createHmac("sha256", process.env.ADMIN_PASSWORD).update(parts[0]).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(parts[1]);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function authUrl(secrets) {
  const url = new URL("https://kauth.kakao.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", secrets.restApiKey);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "talk_message");
  url.searchParams.set("state", makeState());
  return url.toString();
}

async function tokenRequest(params) {
  const body = new URLSearchParams();
  Object.keys(params).forEach(function (key) {
    if (params[key]) body.set(key, params[key]);
  });
  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: body.toString()
  });
  const payload = await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error("kakao-token-" + response.status);
  return payload;
}

async function accessToken(secrets) {
  const payload = await tokenRequest({
    grant_type: "refresh_token",
    client_id: secrets.restApiKey,
    refresh_token: secrets.refreshToken,
    client_secret: secrets.clientSecret || ""
  });
  if (!payload.access_token) throw new Error("kakao-access");
  if (payload.refresh_token) {
    const stored = await readBox();
    stored.secrets.refreshToken = payload.refresh_token;
    await writeBox(stored.secrets, stored.sha);
  }
  return payload.access_token;
}

async function sendTexts(access, texts) {
  for (const text of texts) {
    const template = {
      object_type: "text",
      text: text,
      link: { web_url: SITE, mobile_web_url: SITE },
      button_title: "홈페이지 보기"
    };
    const body = new URLSearchParams();
    body.set("template_object", JSON.stringify(template));
    const response = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + access,
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
      },
      body: body.toString()
    });
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok || payload.result_code !== 0) throw new Error("kakao-send-" + response.status);
  }
}

async function sendInquiry(inquiry) {
  const stored = await readBox();
  const secrets = stored.secrets || {};
  if (!secrets.restApiKey || !secrets.refreshToken) {
    return { error: "지금은 카카오톡으로 전달하지 못했습니다. 033-242-9908로 전화해 주세요.", status: 503 };
  }
  const access = await accessToken(secrets);
  await sendTexts(access, buildMessages(inquiry));
  return { ok: true };
}

async function saveApp(restApiKey, clientSecret) {
  const key = cleanText(restApiKey, 64);
  if (!/^[0-9a-f]{32}$/i.test(key)) return { error: "REST API 키를 다시 확인해 주세요." };
  const secret = cleanText(clientSecret, 128);
  const stored = await readBox();
  stored.secrets.restApiKey = key;
  if (secret) stored.secrets.clientSecret = secret;
  await writeBox(stored.secrets, stored.sha);
  return { ok: true };
}

async function connectStatus() {
  const stored = await readBox();
  const secrets = stored.secrets || {};
  return {
    appReady: Boolean(secrets.restApiKey),
    linked: Boolean(secrets.restApiKey && secrets.refreshToken)
  };
}

async function finishLogin(code) {
  const stored = await readBox();
  const secrets = stored.secrets || {};
  if (!secrets.restApiKey) throw new Error("kakao-app");
  const payload = await tokenRequest({
    grant_type: "authorization_code",
    client_id: secrets.restApiKey,
    redirect_uri: REDIRECT_URI,
    code: code,
    client_secret: secrets.clientSecret || ""
  });
  if (!payload.refresh_token && !secrets.refreshToken) throw new Error("kakao-refresh");
  if (payload.refresh_token) secrets.refreshToken = payload.refresh_token;
  await writeBox(secrets, stored.sha);
  if (payload.access_token) {
    await sendTexts(payload.access_token, ["선한요양보호사교육원 수강 문의가 이 카카오톡으로 도착합니다."]);
  }
}

function resultPage(ok) {
  const title = ok ? "카카오톡 문의 받기가 연결되었습니다" : "카카오톡 연결을 끝내지 못했습니다";
  const body = ok
    ? "수강 문의를 등록하면 이 카카오톡의 나와의 채팅으로 내용이 전달됩니다. 테스트 메시지를 보내 두었습니다."
    : "카카오 로그인, 메시지 전송 동의, 리다이렉트 주소를 확인한 뒤 관리자 화면에서 다시 연결해 주세요.";
  return "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>" + title + "</title></head><body style=\"font-family:sans-serif;line-height:1.7;padding:2rem\"><h1>" + title + "</h1><p>" + body + "</p><p><a href=\"/admin.html\">관리자로 돌아가기</a></p></body></html>";
}

module.exports = {
  passwordOk: passwordOk,
  checkInquiry: checkInquiry,
  buildMessages: buildMessages,
  checkState: checkState,
  authUrl: authUrl,
  sendInquiry: sendInquiry,
  saveApp: saveApp,
  connectStatus: connectStatus,
  finishLogin: finishLogin,
  resultPage: resultPage,
  readBox: readBox
};
