// Vercel 서버리스 함수: 사용자가 붙여넣은 링크의 내용을 서버에서 가져온다.
// (브라우저 CORS 우회) 공개 공유된 구글 시트/드라이브/일반 URL 대상.
// - 구글 스프레드시트 → 해당 탭을 CSV 텍스트로
// - 구글 문서(Docs)   → 본문 텍스트로
// - 구글 드라이브 파일 → PDF/이미지 바이트로
// - 일반 URL          → content-type에 따라 pdf/image/text
// 반환: { kind: "text"|"pdf"|"image", text?, b64?, mediaType? } 또는 { error }

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// 사설/내부 주소 차단(간단 SSRF 방어)
function isBlockedHost(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // 클라우드 메타데이터
  return false;
}

function sniffType(buf) {
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf"; // %PDF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const MAX_BYTES = 18 * 1024 * 1024; // 18MB

async function fetchBytes(url) {
  const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (cosmetic-checker)" } });
  if (!r.ok) throw new Error(`가져오기 실패 (${r.status})`);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("파일이 너무 큽니다 (18MB 초과).");
  return { ct, buf };
}

function looksLikeHtml(ct, buf) {
  if (ct.includes("text/html")) return true;
  const head = buf.slice(0, 200).toString("utf8").toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 허용됩니다." }); return; }

  let url;
  try { ({ url } = await readBody(req)); } catch (_) { res.status(400).json({ error: "잘못된 요청 본문입니다." }); return; }
  if (!url || typeof url !== "string") { res.status(400).json({ error: "url이 필요합니다." }); return; }

  let u;
  try { u = new URL(url.trim()); } catch (_) { res.status(400).json({ error: "올바른 URL이 아닙니다." }); return; }
  if (u.protocol !== "http:" && u.protocol !== "https:") { res.status(400).json({ error: "http/https 링크만 지원합니다." }); return; }
  if (isBlockedHost(u.hostname)) { res.status(400).json({ error: "내부 주소는 가져올 수 없습니다." }); return; }

  try {
    const host = u.hostname;

    // 구글 스프레드시트 → CSV 텍스트
    if (host === "docs.google.com" && /\/spreadsheets\/d\//.test(u.pathname)) {
      const id = u.pathname.match(/\/spreadsheets\/d\/([-\w]+)/)[1];
      const gid = u.searchParams.get("gid") || (u.hash.match(/gid=(\d+)/) || [])[1] || "0";
      const exp = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
      const { ct, buf } = await fetchBytes(exp);
      if (looksLikeHtml(ct, buf)) {
        res.status(400).json({ error: "시트를 열 수 없습니다. '링크가 있는 모든 사용자 - 보기'로 공유되어 있는지 확인하세요." });
        return;
      }
      res.status(200).json({ kind: "text", text: buf.toString("utf8") });
      return;
    }

    // 구글 문서(Docs) → 본문 텍스트
    if (host === "docs.google.com" && /\/document\/d\//.test(u.pathname)) {
      const id = u.pathname.match(/\/document\/d\/([-\w]+)/)[1];
      const exp = `https://docs.google.com/document/d/${id}/export?format=txt`;
      const { ct, buf } = await fetchBytes(exp);
      if (looksLikeHtml(ct, buf)) {
        res.status(400).json({ error: "문서를 열 수 없습니다. 공개(링크 보기) 공유 여부를 확인하세요." });
        return;
      }
      res.status(200).json({ kind: "text", text: buf.toString("utf8") });
      return;
    }

    // 구글 드라이브 파일 → 다운로드
    if (host === "drive.google.com" || host === "drive.usercontent.google.com") {
      const id =
        (u.pathname.match(/\/file\/d\/([-\w]+)/) || [])[1] ||
        u.searchParams.get("id");
      if (!id) { res.status(400).json({ error: "드라이브 파일 ID를 찾지 못했습니다." }); return; }
      const dl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
      const { ct, buf } = await fetchBytes(dl);
      if (looksLikeHtml(ct, buf)) {
        res.status(400).json({ error: "드라이브 파일을 내려받지 못했습니다. 공개(링크 보기) 공유 여부, 또는 파일 크기를 확인하세요." });
        return;
      }
      const type = sniffType(buf) || ct;
      if (type === "application/pdf") { res.status(200).json({ kind: "pdf", b64: buf.toString("base64") }); return; }
      if (type.startsWith && type.startsWith("image/")) { res.status(200).json({ kind: "image", b64: buf.toString("base64"), mediaType: type }); return; }
      res.status(400).json({ error: `지원하지 않는 파일 형식입니다 (${type || "알 수 없음"}). PDF 또는 이미지만 됩니다.` });
      return;
    }

    // 일반 URL
    const { ct, buf } = await fetchBytes(u.toString());
    const type = sniffType(buf) || ct;
    if (type.includes("application/pdf") || type === "application/pdf") {
      res.status(200).json({ kind: "pdf", b64: buf.toString("base64") }); return;
    }
    if (type.startsWith && type.startsWith("image/")) {
      res.status(200).json({ kind: "image", b64: buf.toString("base64"), mediaType: type.split(";")[0] }); return;
    }
    if (type.includes("text/") || type.includes("csv")) {
      res.status(200).json({ kind: "text", text: buf.toString("utf8") }); return;
    }
    res.status(400).json({ error: `지원하지 않는 형식입니다 (${type || "알 수 없음"}). PDF·이미지·텍스트 링크만 됩니다.` });
  } catch (err) {
    res.status(502).json({ error: `링크 가져오기 실패: ${err.message}` });
  }
};
