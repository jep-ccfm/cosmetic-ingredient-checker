// Vercel 서버리스 함수: 패키지 이미지에서 전성분을 추출한다.
// 회사 Claude API 키를 서버 환경변수(ANTHROPIC_API_KEY)에 보관하고,
// 브라우저가 보낸 이미지를 Claude 비전에 전달한다. 키는 브라우저에 노출되지 않는다.
// 의존성 없이 Node 18+ 내장 fetch만 사용한다.

const MODEL = process.env.MODEL || "claude-opus-4-8";

const PROMPT = `이 이미지는 화장품 패키지(단상자)입니다.
이미지에서 '전성분' 또는 성분 목록을 찾아 정확하게 추출해 주세요.

규칙:
- 성분명만 추출 (쉼표로 구분된 목록 형태로 출력)
- '전성분:', '성분:' 등의 라벨 텍스트는 제외
- 원본 텍스트를 수정하지 말고 그대로 유지 (오탈자도 그대로)
- 한국어와 영어 성분명 모두 원문 그대로 포함
- 다른 설명 없이 성분 목록만 출력

출력 예시:
정제수, 글리세린, Niacinamide, 부틸렌글라이콜, 1,2-헥산디올`;

async function readBody(req) {
  if (req.body) {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST만 허용됩니다." });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다." });
    return;
  }

  let images, mediaType;
  try {
    ({ images, mediaType = "image/jpeg" } = await readBody(req));
  } catch (_) {
    res.status(400).json({ error: "잘못된 요청 본문입니다." });
    return;
  }
  if (!Array.isArray(images) || images.length === 0) {
    res.status(400).json({ error: "이미지가 없습니다." });
    return;
  }

  // Claude 메시지 content 구성
  const content = [];
  images.forEach((b64, i) => {
    if (images.length > 1) content.push({ type: "text", text: `[${i + 1}페이지]` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: b64 },
    });
  });
  content.push({ type: "text", text: PROMPT });

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      res.status(502).json({ error: `Claude API 오류 (${apiRes.status}): ${errText.slice(0, 300)}` });
      return;
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    res.status(200).json({ text: (textBlock ? textBlock.text : "").trim() });
  } catch (err) {
    res.status(500).json({ error: `요청 처리 실패: ${err.message}` });
  }
};
