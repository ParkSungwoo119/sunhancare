const { send, sendHtml, readJson } = require("../lib/http");
const kakao = require("../lib/kakao");

function stateDetail(reason) {
  if (reason === "expired") return "인증 시간이 지났습니다. 관리자 화면에서 다시 연결해 주세요.";
  if (reason === "password") return "서버의 관리자 비밀번호 설정을 확인해 주세요.";
  return "인증 확인값이 맞지 않습니다. 관리자 화면에서 다시 연결해 주세요.";
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const query = kakao.callbackQuery(req);
      const state = kakao.readAppState(query.state);
      const cookieApp = kakao.appFromCookie(req);
      let app = { source: "store" };
      if (state.ok && state.app && state.app.restApiKey) {
        app = { restApiKey: state.app.restApiKey, clientSecret: state.app.clientSecret || "", source: "state" };
      } else if (cookieApp.restApiKey) {
        app = { restApiKey: cookieApp.restApiKey, clientSecret: cookieApp.clientSecret || "", source: "cookie" };
      }
      kakao.logKakao({
        step: "callback",
        path: String(req.url || "").split("?")[0],
        queryKeys: Object.keys(req.query || {}),
        hasCode: Boolean(query.code),
        stateReason: state.reason,
        error: query.error,
        errorDescription: String(query.errorDescription || "").slice(0, 180),
        keySource: app.source,
        hasClientSecret: Boolean(app.clientSecret)
      });
      if (!query.code || query.error || !state.ok) {
        const detail = kakao.callbackDetail(query) || stateDetail(query.error ? "kakao" : state.reason);
        sendHtml(res, 400, kakao.resultPage(false, detail));
        return;
      }
      if (app.source === "store") {
        kakao.logKakao({ step: "callback-key", keySource: "store" });
      }
      const result = await kakao.finishLogin(query.code, app);
      res.setHeader("Set-Cookie", "sunhan_kakao_app=; HttpOnly; Secure; SameSite=Lax; Path=/api/kakao; Max-Age=0");
      sendHtml(res, 200, kakao.resultPage(true, result.testDetail));
      return;
    }

    if (req.method !== "POST") {
      send(res, 405, { error: "허용되지 않은 요청입니다." });
      return;
    }

    const body = await readJson(req);
    if (!kakao.passwordOk(body.password)) {
      send(res, 401, { error: "비밀번호가 맞지 않습니다." });
      return;
    }

    if (body.action === "status") {
      send(res, 200, await kakao.connectStatus());
      return;
    }

    if (body.action === "save-app") {
      const saved = await kakao.saveApp(body.restApiKey, body.clientSecret);
      if (saved.error) {
        send(res, 400, { error: saved.error });
        return;
      }
      send(res, 200, { ok: true });
      return;
    }

    if (body.action === "start") {
      let app = null;
      if (body.restApiKey) {
        const normalized = kakao.normalizeApp(body.restApiKey, body.clientSecret);
        if (normalized.error) {
          send(res, 400, { error: normalized.error });
          return;
        }
        try {
          const saved = await kakao.saveApp(body.restApiKey, body.clientSecret);
          if (saved.error) {
            send(res, 400, { error: saved.error });
            return;
          }
          app = { restApiKey: saved.restApiKey, clientSecret: saved.clientSecret || "" };
        } catch (error) {
          kakao.logKakao({ step: "save-app", message: error && error.message ? error.message : "save-failed" });
          app = { restApiKey: normalized.restApiKey, clientSecret: normalized.clientSecret || "" };
        }
      } else {
        const stored = await kakao.readBox();
        const secrets = stored.secrets || {};
        app = { restApiKey: secrets.restApiKey || "", clientSecret: secrets.clientSecret || "" };
      }
      if (!app.restApiKey) {
        send(res, 400, { error: "REST API 키를 먼저 저장해 주세요." });
        return;
      }
      kakao.logKakao({
        step: "start",
        clientIdLength: String(app.restApiKey).length,
        hasClientSecret: Boolean(app.clientSecret),
        fromForm: Boolean(body.restApiKey)
      });
      res.setHeader("Set-Cookie", kakao.appCookie(kakao.sealApp(app)));
      send(res, 200, { url: kakao.authUrl(app) });
      return;
    }

    send(res, 400, { error: "요청을 처리할 수 없습니다." });
  } catch (error) {
    kakao.logKakao({
      step: "handler",
      message: error && error.message ? error.message : "kakao-error",
      detail: error && error.detail ? error.detail : ""
    });
    console.error(error && error.stack ? error.stack : error);
    if (req.method === "GET") {
      sendHtml(res, 500, kakao.resultPage(false, (error && error.detail) || "카카오 토큰 교환 중 문제가 생겼습니다. 관리자 화면에서 다시 연결해 주세요."));
      return;
    }
    send(res, 500, { error: "카카오톡 연결 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요." });
  }
};
