// Vercel 서버리스 함수: 기준 문안 PDF와 디자인 PDF를 대조하여
// 디자인(패키지)의 문제 지점을 찾아낸다.
// 기준 문안 = 정답. 디자인에서 오탈자/미기재/오기재를 찾고,
// 각 문제의 위치(디자인 페이지 + 정규화 박스 좌표)를 함께 반환한다.
// 회사 Claude API 키는 서버 환경변수(ANTHROPIC_API_KEY)에만 보관된다.

const MODEL = process.env.MODEL || "claude-opus-4-8";

const INSTRUCTION = `당신은 화장품 패키지 문안을 검수하는 전문 교정자입니다.

두 종류의 자료가 주어집니다.
- [기준 문안]: 무조건 올바른 정답 자료. 여기에 적힌 문구가 기준입니다.
- [디자인]: 실제 인쇄될 패키지 디자인. 검수 대상이며, 이 안에서 문제 지점을 찾습니다.

두 자료의 텍스트를 모두 읽고, "내용(문구)" 기준으로 짝을 지어 대조하세요.
두 자료는 레이아웃과 위치가 서로 다를 수 있으니, 위치가 아니라 내용으로 매칭합니다.

판독 규칙:
- 이미지가 회전되거나 뒤집혀 있어도 올바른 방향으로 읽어 텍스트를 추출하세요.
- 해상도가 낮아 흐릿해도 최대한 정확히 판독하고, 확신이 없으면 detail에 "판독 불확실"을 명시하세요.
- 단순 줄바꿈/띄어쓰기/글꿴/배열 같은 디자인 차이는 무시하고, 실제 문구·철자·숫자·성분의 차이에만 집중하세요.

문제 분류:
- "오탈자": 같은 항목인데 철자/글자가 틀림 (예: 히아루론산 → 히알루론산)
- "미기재": 기준 문안에는 있는데 디자인에 빠진 내용
- "오기재": 디자인에만 있거나, 숫자/용량/문구가 기준과 다르게 잘못 적힌 내용
- "기타": 그 외 확인이 필요한 사항

위치 좌표(중요):
- 각 문제가 "디자인"의 어느 위치인지 표시해야 합니다.
- 디자인 이미지는 순서대로 1페이지, 2페이지... 로 제공됩니다.
- 문제가 있는 디자인 페이지 번호를 page(정수)로, 그 문제 텍스트를 감싸는 사각형을
  box=[x0, y0, x1, y1] 로 주세요. 각 값은 해당 페이지 이미지 기준 0.0~1.0 정규화 좌표입니다
  (x0,y0 = 좌상단, x1,y1 = 우하단).
- "미기재"처럼 디자인에 위치가 없는 경우 page=null, box=null 로 두세요.

반드시 아래 JSON 형식으로만 출력하세요 (설명 문장·코드펜스 없이 JSON 객체만):
{
  "reference_text": "기준 문안에서 읽은 전체 텍스트",
  "target_text": "디자인에서 읽은 전체 텍스트",
  "notes": "회전/화질 등 특이사항 (없으면 빈 문자열)",
  "findings": [
    {
      "category": "오탈자",
      "location": "어느 부분인지 (예: 전성분, 사용법, 용량 표기, 주의사항, 제품명 등)",
      "reference": "기준 문안 내용 (미기재가 아니면 채움)",
      "target": "디자인 내용 (없으면 (없음))",
      "detail": "무엇이 어떻게 틀렸는지 구체적으로",
      "page": 1,
      "box": [0.12, 0.34, 0.56, 0.39]
    }
  ]
}
문제가 없으면 findings는 빈 배열([])로 두세요.`;

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function pushImages(content, images, labelPrefix, mediaType) {
  images.forEach((b64, i) => {
    content.push({ type: "text", text: `[${labelPrefix} - ${i + 1}페이지]` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: b64 },
    });
  });
}

function parseJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s !== -1 && e !== -1) t = t.slice(s, e + 1);
  return JSON.parse(t);
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

  let reference, target, mediaType;
  try {
    ({ reference, target, mediaType = "image/jpeg" } = await readBody(req));
  } catch (_) {
    res.status(400).json({ error: "잘못된 요청 본문입니다." });
    return;
  }
  if (!Array.isArray(reference) || !reference.length || !Array.isArray(target) || !target.length) {
    res.status(400).json({ error: "기준 문안/디자인 이미지가 모두 필요합니다." });
    return;
  }

  const content = [];
  content.push({ type: "text", text: "===== [기준 문안] (정답 자료) =====" });
  pushImages(content, reference, "기준 문안", mediaType);
  content.push({ type: "text", text: "===== [디자인] (검수 대상) =====" });
  pushImages(content, target, "디자인", mediaType);
  content.push({ type: "text", text: INSTRUCTION });

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
        max_tokens: 8192,
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
    const raw = textBlock ? textBlock.text : "";

    let parsed;
    try {
      parsed = parseJson(raw);
    } catch (_) {
      res.status(200).json({ raw, parseError: true });
      return;
    }
    res.status(200).json({ data: parsed });
  } catch (err) {
    res.status(500).json({ error: `요청 처리 실패: ${err.message}` });
  }
};
