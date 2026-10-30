const { send, sendHtml, readJson } = require("../lib/http");
const kakao = require("../lib/kakao");

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "https://sunhancare.vercel.app");
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      const error = url.searchParams.get("error") || "";
      if (!code || error || !kakao.checkState(state)) {
        sendHtml(res, 400, kakao.resultPage(false));
        return;
      }
      await kakao.finishLogin(code);
      sendHtml(res, 200, kakao.resultPage(true));
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
      const stored = await kakao.readBox();
      const secrets = stored.secrets || {};
      if (!secrets.restApiKey) {
        send(res, 400, { error: "REST API 키를 먼저 저장해 주세요." });
        return;
      }
      send(res, 200, { url: kakao.authUrl(secrets) });
      return;
    }

    send(res, 400, { error: "요청을 처리할 수 없습니다." });
  } catch (error) {
    console.error(error && error.message ? error.message : "kakao-error");
    if (req.method === "GET") {
      sendHtml(res, 500, kakao.resultPage(false));
      return;
    }
    send(res, 500, { error: "카카오톡 연결 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요." });
  }
};
