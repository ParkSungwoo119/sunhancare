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
  try {
    return { secrets: open(JSON.parse(text || "{}")), sha: payload.sha || "" };
  } catch (error) {
    logKakao({ step: "store-open", message: error && error.message ? error.message : "open-failed" });
    return { secrets: {}, sha: payload.sha || "" };
  }
}

async function writeBox(secrets, sha) {
  if (!process.env.GITHUB_TOKEN) throw new Error("github-token");
  let currentSha = sha || "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + FILE_PATH, {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, githubHeaders()),
      body: JSON.stringify({
        message: "Store the Kakao inquiry connection",
        content: Buffer.from(JSON.stringify(seal(secrets)) + "\n").toString("base64"),
        sha: currentSha || undefined,
        branch: "main"
      })
    });
    if (response.ok) return;
    const payload = await response.json().catch(function () { return {}; });
    logKakao({ step: "store-write", status: response.status, message: String(payload.message || "").slice(0, 180) });
    if (response.status !== 409 || attempt === 1) throw new Error("github-write-" + response.status);
    const fresh = await readBox();
    currentSha = fresh.sha;
    secrets = Object.assign({}, fresh.secrets, secrets);
  }
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

function logKakao(fields) {
  console.log("[kakao] " + JSON.stringify(fields));
}

function appKey() {
  const secret = process.env.ADMIN_PASSWORD || "";
  if (!secret) return null;
  return crypto.createHash("sha256").update("sunhan-kakao-app:" + secret).digest();
}

function sealApp(app) {
  const key = appKey();
  if (!key) throw new Error("admin-password");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify({
      restApiKey: app.restApiKey || "",
      clientSecret: app.clientSecret || ""
    }), "utf8"),
    cipher.final()
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

function openAppSeal(sealed) {
  const key = appKey();
  if (!key || !sealed) return {};
  const packed = Buffer.from(String(sealed), "base64url");
  if (packed.length < 29) return {};
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  const text = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function makeState(app) {
  const stamp = String(Date.now());
  const sealed = sealApp(app || {});
  const mac = crypto.createHmac("sha256", process.env.ADMIN_PASSWORD || "").update(stamp + "." + sealed).digest("base64url");
  return stamp + "." + mac + "." + sealed;
}

function readAppState(state) {
  const parts = String(state || "").split(".");
  if (!process.env.ADMIN_PASSWORD) return { ok: false, reason: "password", app: {} };
  if (parts.length !== 2 && parts.length !== 3) return { ok: false, reason: "format", app: {} };
  const stamp = Number(parts[0]);
  if (!stamp || Math.abs(Date.now() - stamp) > 10 * 60 * 1000) return { ok: false, reason: "expired", app: {} };
  const signed = parts.length === 3 ? parts[0] + "." + parts[2] : parts[0];
  const mac = crypto.createHmac("sha256", process.env.ADMIN_PASSWORD).update(signed).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(parts[1]);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return { ok: false, reason: "mismatch", app: {} };
  if (parts.length !== 3) return { ok: true, reason: "ok", app: {} };
  try {
    return { ok: true, reason: "ok", app: openAppSeal(parts[2]) };
  } catch (error) {
    logKakao({ step: "state-open", message: error && error.message ? error.message : "state-open-failed" });
    return { ok: false, reason: "seal", app: {} };
  }
}

function appCookie(sealed) {
  return "sunhan_kakao_app=" + encodeURIComponent(sealed) + "; HttpOnly; Secure; SameSite=Lax; Path=/api/kakao; Max-Age=600";
}

function readRequestCookie(req, name) {
  if (req.cookies && req.cookies[name]) return String(req.cookies[name]);
  const header = String((req.headers && req.headers.cookie) || "");
  const parts = header.split(/; */);
  for (let index = 0; index < parts.length; index += 1) {
    const pair = parts[index];
    const cut = pair.indexOf("=");
    if (cut > 0 && pair.slice(0, cut) === name) return decodeURIComponent(pair.slice(cut + 1));
  }
  return "";
}

function appFromCookie(req) {
  try {
    return openAppSeal(readRequestCookie(req, "sunhan_kakao_app"));
  } catch (error) {
    logKakao({ step: "cookie-open", message: error && error.message ? error.message : "cookie-open-failed" });
    return {};
  }
}

function callbackQuery(req) {
  const url = new URL(req.url || "/", "https://sunhancare.vercel.app");
  const query = req.query && typeof req.query === "object" ? req.query : {};
  function pick(name) {
    const fromQuery = query[name];
    const value = Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
    return String(value || url.searchParams.get(name) || "");
  }
  return {
    code: pick("code"),
    state: pick("state"),
    error: pick("error"),
    errorDescription: pick("error_description")
  };
}

function authUrl(secrets) {
  const url = new URL("https://kauth.kakao.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", secrets.restApiKey);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "talk_message");
  url.searchParams.set("state", makeState(secrets));
  return url.toString();
}

function tokenBody(params) {
  const body = new URLSearchParams();
  ["grant_type", "client_id", "redirect_uri", "code", "refresh_token"].forEach(function (key) {
    if (params[key]) body.set(key, params[key]);
  });
  if (params.client_secret) body.set("client_secret", params.client_secret);
  return body;
}

function tokenDetail(payload) {
  const code = String((payload && (payload.error || payload.error_code || payload.code)) || "");
  const description = String((payload && (payload.error_description || payload.msg)) || "");
  const joined = code + " " + description;
  if (/invalid_client|KOE010/i.test(joined)) {
    return "REST API 키로 토큰을 받지 못했습니다. 자바스크립트 키가 아닌지 확인하고, 카카오에서 클라이언트 시크릿을 켜 두었다면 그 값을 입력하거나 시크릿을 꺼 주세요.";
  }
  if (/redirect_uri|KOE006|KOE303/i.test(joined)) {
    return "리다이렉트 주소가 카카오에 등록된 주소와 다릅니다. https://sunhancare.vercel.app/api/kakao 를 그대로 등록해 주세요.";
  }
  if (/invalid_grant|KOE320/i.test(joined)) {
    return "인증 시간이 지났거나 코드가 이미 사용되었습니다. 관리자 화면에서 다시 연결해 주세요.";
  }
  const extra = [code, description].filter(Boolean).join(" / ").slice(0, 180);
  return extra ? "카카오 토큰 발급에 실패했습니다. (" + extra + ")" : "카카오 토큰 발급에 실패했습니다.";
}

async function tokenRequest(params) {
  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: tokenBody(params).toString()
  });
  const payload = await response.json().catch(function () { return {}; });
  if (!response.ok) {
    logKakao({
      step: "token",
      grantType: params.grant_type || "",
      status: response.status,
      error: payload.error || "",
      errorCode: payload.error_code || payload.code || "",
      errorDescription: String(payload.error_description || payload.msg || "").slice(0, 180),
      hasClientId: Boolean(params.client_id),
      clientIdLength: String(params.client_id || "").length,
      hasClientSecret: Boolean(params.client_secret),
      redirectUri: params.redirect_uri || ""
    });
    const error = new Error("kakao-token-" + response.status);
    error.detail = tokenDetail(payload);
    throw error;
  }
  logKakao({
    step: "token-ok",
    grantType: params.grant_type || "",
    hasAccessToken: Boolean(payload.access_token),
    hasRefreshToken: Boolean(payload.refresh_token)
  });
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
    stored.secrets.restApiKey = stored.secrets.restApiKey || secrets.restApiKey;
    if (secrets.clientSecret) stored.secrets.clientSecret = secrets.clientSecret;
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
    if (!response.ok || payload.result_code !== 0) {
      logKakao({
        step: "send",
        status: response.status,
        code: payload.code || payload.result_code || "",
        message: String(payload.msg || payload.error_description || "").slice(0, 180)
      });
      const error = new Error("kakao-send-" + response.status);
      error.detail = "카카오톡 테스트 메시지를 보내지 못했습니다.";
      throw error;
    }
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

function normalizeApp(restApiKey, clientSecret) {
  const key = cleanText(restApiKey, 64);
  if (!/^[0-9a-f]{32}$/i.test(key)) return { error: "REST API 키를 다시 확인해 주세요." };
  return { restApiKey: key, clientSecret: cleanText(clientSecret, 128) };
}

async function saveApp(restApiKey, clientSecret) {
  const app = normalizeApp(restApiKey, clientSecret);
  if (app.error) return app;
  const stored = await readBox();
  stored.secrets.restApiKey = app.restApiKey;
  if (app.clientSecret) stored.secrets.clientSecret = app.clientSecret;
  else delete stored.secrets.clientSecret;
  await writeBox(stored.secrets, stored.sha);
  return { ok: true, restApiKey: app.restApiKey, clientSecret: app.clientSecret };
}

async function connectStatus() {
  const stored = await readBox();
  const secrets = stored.secrets || {};
  return {
    appReady: Boolean(secrets.restApiKey),
    linked: Boolean(secrets.restApiKey && secrets.refreshToken)
  };
}

async function finishLogin(code, app) {
  const stored = await readBox();
  const secrets = Object.assign({}, stored.secrets || {});
  const fromLogin = app && app.restApiKey ? app : {};
  if (fromLogin.restApiKey) secrets.restApiKey = fromLogin.restApiKey;
  if (fromLogin.restApiKey) {
    if (fromLogin.clientSecret) secrets.clientSecret = fromLogin.clientSecret;
    else delete secrets.clientSecret;
  }
  if (!secrets.restApiKey) {
    const error = new Error("kakao-app");
    error.detail = "REST API 키가 전달되지 않았습니다. 관리자 화면에서 키를 다시 입력해 주세요.";
    throw error;
  }
  logKakao({
    step: "exchange",
    keySource: app && app.source ? app.source : "store",
    clientIdLength: String(secrets.restApiKey).length,
    hasClientSecret: Boolean(secrets.clientSecret)
  });
  const payload = await tokenRequest({
    grant_type: "authorization_code",
    client_id: secrets.restApiKey,
    redirect_uri: REDIRECT_URI,
    code: code,
    client_secret: secrets.clientSecret || ""
  });
  if (!payload.refresh_token && !secrets.refreshToken) {
    const error = new Error("kakao-refresh");
    error.detail = "카카오가 다시 로그인할 수 있는 토큰을 주지 않았습니다. 카카오톡 메시지 전송에 동의한 뒤 다시 연결해 주세요.";
    throw error;
  }
  if (payload.refresh_token) secrets.refreshToken = payload.refresh_token;
  try {
    await writeBox(secrets, stored.sha);
  } catch (error) {
    error.detail = "카카오 토큰은 받았지만 연결을 저장하지 못했습니다. 잠시 후 다시 연결해 주세요.";
    throw error;
  }
  let testDetail = "";
  if (payload.access_token) {
    try {
      await sendTexts(payload.access_token, ["선한요양보호사교육원 수강 문의가 이 카카오톡으로 도착합니다."]);
    } catch (error) {
      logKakao({ step: "test-message", message: error && error.message ? error.message : "test-failed" });
      testDetail = "연결은 저장되었습니다. 테스트 메시지는 도착하지 않았습니다. 수강 문의를 한 번 등록해 확인해 주세요.";
    }
  }
  return { testDetail: testDetail };
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
  });
}

function resultPage(ok, detail) {
  const title = ok ? "카카오톡 문의 받기가 연결되었습니다" : "카카오톡 연결을 끝내지 못했습니다";
  const body = detail || (ok
    ? "수강 문의를 등록하면 이 카카오톡의 나와의 채팅으로 내용이 전달됩니다. 테스트 메시지를 보내 두었습니다."
    : "카카오 로그인, 메시지 전송 동의, 리다이렉트 주소를 확인한 뒤 관리자 화면에서 다시 연결해 주세요.");
  return "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>" + escapeHtml(title) + "</title></head><body style=\"font-family:sans-serif;line-height:1.7;padding:2rem\"><h1>" + escapeHtml(title) + "</h1><p>" + escapeHtml(body) + "</p><p><a href=\"/admin.html\">관리자로 돌아가기</a></p></body></html>";
}

function callbackDetail(query) {
  const text = String(query.error || "") + " " + String(query.errorDescription || "");
  if (query.error === "access_denied") return "카카오톡 메시지 전송 동의가 취소되었습니다. 다시 연결하면서 동의해 주세요.";
  if (/scope|consent/i.test(text)) return "카카오 개발자 앱의 동의항목에서 카카오톡 메시지 전송을 켜 주세요.";
  if (query.error) return "카카오 로그인 응답: " + [query.error, query.errorDescription].filter(Boolean).join(" / ").slice(0, 180);
  return "";
}

module.exports = {
  passwordOk: passwordOk,
  checkInquiry: checkInquiry,
  buildMessages: buildMessages,
  readAppState: readAppState,
  appCookie: appCookie,
  appFromCookie: appFromCookie,
  callbackQuery: callbackQuery,
  sealApp: sealApp,
  normalizeApp: normalizeApp,
  tokenBody: tokenBody,
  authUrl: authUrl,
  sendInquiry: sendInquiry,
  saveApp: saveApp,
  connectStatus: connectStatus,
  finishLogin: finishLogin,
  resultPage: resultPage,
  callbackDetail: callbackDetail,
  logKakao: logKakao,
  readBox: readBox
};
