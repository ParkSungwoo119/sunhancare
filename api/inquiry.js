const { send, readJson } = require("../lib/http");
const { checkInquiry, sendInquiry } = require("../lib/kakao");

const hits = new Map();

function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(function (time) { return now - time < 10 * 60 * 1000; });
  if (recent.length >= 5) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      send(res, 405, { error: "허용되지 않은 요청입니다." });
      return;
    }
    const forwarded = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "");
    if (tooMany(forwarded.split(",")[0].trim() || "unknown")) {
      send(res, 429, { error: "문의가 잠시 많이 들어왔습니다. 조금 뒤에 다시 등록해 주세요." });
      return;
    }
    const body = await readJson(req);
    const checked = checkInquiry(body);
    if (checked.error) {
      send(res, 400, { error: checked.error });
      return;
    }
    const result = await sendInquiry(checked.inquiry);
    if (result.error) {
      send(res, result.status || 502, { error: result.error });
      return;
    }
    send(res, 200, { ok: true });
  } catch (error) {
    console.error(error && error.message ? error.message : "inquiry-error");
    send(res, 502, { error: "카카오톡으로 전달하지 못했습니다. 전화로 문의해 주세요." });
  }
};
