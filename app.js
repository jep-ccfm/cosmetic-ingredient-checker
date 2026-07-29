// 화장품 성분 오탈자 검사기 — 프론트엔드 로직
// PDF → 이미지 → /api/extract(Claude 비전) → 성분 목록
// 엑셀 셀 → 성분 목록
// 두 목록 비교(오탈자 / 불일치 / 순서)

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

// ── 상태
let pdfFile = null;
let excelFile = null;

// ── DOM
const $ = (id) => document.getElementById(id);
const pdfInput = $("pdf-input");
const excelInput = $("excel-input");
const analyzeBtn = $("analyze-btn");
const statusEl = $("status");

pdfInput.addEventListener("change", (e) => {
  pdfFile = e.target.files[0] || null;
  setFileName("pdf-name", pdfFile);
});
excelInput.addEventListener("change", (e) => {
  excelFile = e.target.files[0] || null;
  setFileName("excel-name", excelFile);
});

function setFileName(id, file) {
  const el = $(id);
  el.textContent = file ? file.name : "선택된 파일 없음";
  el.classList.toggle("set", !!file);
}

// ── 탭 전환
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("tab-" + tab.dataset.tab).classList.add("active");
  });
});

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ── 분석 시작
analyzeBtn.addEventListener("click", runAnalysis);

async function runAnalysis() {
  if (!pdfFile) return alert("PDF 파일을 선택해주세요.");
  if (!excelFile) return alert("엑셀 파일을 선택해주세요.");

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "분석 중...";
  try {
    setStatus("PDF를 이미지로 변환하는 중...");
    const images = await pdfToImages(pdfFile);

    setStatus("이미지에서 성분을 추출하는 중... (AI 판독, 잠시 기다려 주세요)");
    const pdfRaw = await extractFromImages(images);

    setStatus("엑셀에서 성분을 읽는 중...");
    const { text: excelRaw, warn: excelWarn } = await readFromExcel(excelFile);

    setStatus("성분 목록을 비교하는 중...");
    const pdfList = parseIngredients(pdfRaw);
    const excelList = excelRaw ? parseIngredients(excelRaw) : [];
    const result = compareIngredients(pdfList, excelList);

    renderResults({ pdfList, excelList, result, excelWarn });
    activateTab("result");
    setStatus(
      `분석 완료  |  PDF ${pdfList.length}개  /  엑셀 ${excelList.length}개  |  문제 ${result.issueCount}건`
    );
  } catch (err) {
    console.error(err);
    $("tab-result").innerHTML = `<div class="err-box">분석 중 오류: ${escapeHtml(
      err.message || String(err)
    )}</div>`;
    activateTab("result");
    setStatus("오류가 발생했습니다.");
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "분석 시작";
  }
}

function activateTab(name) {
  document.querySelector(`.tab[data-tab="${name}"]`).click();
}

// ── PDF → 이미지(JPEG base64) 배열
async function pdfToImages(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const images = [];
  const MAX_EDGE = 2000; // 판독 정확도와 전송 크기의 균형

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, MAX_EDGE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale: Math.max(scale, 1) });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    images.push(dataUrl.split(",")[1]); // base64 본문만
  }
  return images;
}

// ── 서버리스 함수로 이미지 전송 → 성분 텍스트
async function extractFromImages(images) {
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images, mediaType: "image/jpeg" }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch (_) {}
    throw new Error(`이미지 판독 실패 (${res.status}) ${detail}`);
  }
  const data = await res.json();
  return (data.text || "").trim();
}

// ── 엑셀 셀 읽기 (SheetJS)
async function readFromExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName = $("sheet-name").value.trim();
  const cellAddr = $("cell-addr").value.trim().toUpperCase();
  const all = wb.SheetNames;

  let ws, warn = "";
  if (all.includes(sheetName)) {
    ws = wb.Sheets[sheetName];
  } else {
    ws = wb.Sheets[all[0]];
    warn = `⚠️ 시트명 '${sheetName}'을(를) 찾을 수 없어 '${all[0]}' 시트로 대체했습니다. (시트 목록: ${all.join(", ")})`;
  }

  const cell = ws[cellAddr];
  const value = cell ? cell.v : null;
  if (value === null || value === undefined || String(value).trim() === "") {
    return {
      text: "",
      warn:
        `⚠️ 셀 ${cellAddr}이(가) 비어 있어 엑셀 비교를 건너뜁니다. (시트 목록: ${all.join(", ")})`,
    };
  }
  return { text: String(value).trim(), warn };
}

// ── 성분 파싱 (콤마 분리 + '1,2-헥산디올' 류 복원)
function parseIngredients(raw) {
  const tokens = raw
    .replace(/\r/g, "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  // "1" + "2-헥산디올" → "1,2-헥산디올" 로 재결합
  const merged = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    const next = tokens[i + 1];
    if (/^\d+$/.test(cur) && next && /^\d+-/.test(next)) {
      merged.push(cur + "," + next);
      i++; // next 소비
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function normalize(s) {
  return s.toLowerCase().replace(/[\s​]/g, "").trim();
}

// ── Levenshtein 기반 유사도 (difflib ratio 대체)
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  const dist = prev[n];
  return 1 - dist / Math.max(m, n);
}

// 어느 글자가 다른지 표시
function diffMarkup(pdf, excel) {
  let s = 0;
  while (s < pdf.length && s < excel.length && pdf[s] === excel[s]) s++;
  let ep = pdf.length, ee = excel.length;
  while (ep > s && ee > s && pdf[ep - 1] === excel[ee - 1]) { ep--; ee--; }
  const pdfHtml =
    escapeHtml(pdf.slice(0, s)) +
    `<span class="diff-del">${escapeHtml(pdf.slice(s, ep))}</span>` +
    escapeHtml(pdf.slice(ep));
  const exHtml =
    escapeHtml(excel.slice(0, s)) +
    `<span class="diff-ins">${escapeHtml(excel.slice(s, ee))}</span>` +
    escapeHtml(excel.slice(ee));
  return { pdfHtml, exHtml };
}

// ── 비교
function compareIngredients(pdfList, excelList) {
  const pdfNorm = new Map();
  const excelNorm = new Map();
  pdfList.forEach((s) => pdfNorm.set(normalize(s), s));
  excelList.forEach((s) => excelNorm.set(normalize(s), s));

  const pdfKeys = new Set(pdfNorm.keys());
  const excelKeys = new Set(excelNorm.keys());
  const exact = [...pdfKeys].filter((k) => excelKeys.has(k));
  const onlyPdf = [...pdfKeys].filter((k) => !excelKeys.has(k));
  const onlyExcel = [...excelKeys].filter((k) => !pdfKeys.has(k));

  // 오탈자 후보: 유사도 ≥ 0.7
  const typos = [];
  const usedExcel = new Set();
  for (const pk of onlyPdf) {
    let best = 0, bestEk = null;
    for (const ek of onlyExcel) {
      if (usedExcel.has(ek)) continue;
      const r = similarity(pk, ek);
      if (r > best) { best = r; bestEk = ek; }
    }
    if (bestEk && best >= 0.7) {
      typos.push({ pdf: pdfNorm.get(pk), excel: excelNorm.get(bestEk), ratio: best });
      usedExcel.add(bestEk);
    }
  }
  const matchedPdf = new Set(typos.map((t) => normalize(t.pdf)));
  const matchedExcel = new Set(typos.map((t) => normalize(t.excel)));

  // 순서 검사: 위치별 비교 (정규화 기준)
  const pdfSeq = pdfList.map(normalize);
  const excelSeq = excelList.map(normalize);
  let orderMismatchIdx = -1;
  const cmpLen = Math.min(pdfSeq.length, excelSeq.length);
  for (let i = 0; i < cmpLen; i++) {
    if (pdfSeq[i] !== excelSeq[i]) { orderMismatchIdx = i; break; }
  }
  const orderMatched =
    orderMismatchIdx === -1 && pdfSeq.length === excelSeq.length;

  const only_pdf = onlyPdf.filter((k) => !matchedPdf.has(k)).map((k) => pdfNorm.get(k));
  const only_excel = onlyExcel.filter((k) => !matchedExcel.has(k)).map((k) => excelNorm.get(k));

  const issueCount = typos.length + only_pdf.length + only_excel.length + (orderMatched ? 0 : (excelList.length ? 1 : 0));

  return {
    pdfCount: pdfList.length,
    excelCount: excelList.length,
    exact: exact.map((k) => pdfNorm.get(k)),
    only_pdf,
    only_excel,
    typos,
    orderMatched,
    orderMismatchIdx,
    hasExcel: excelList.length > 0,
    issueCount,
  };
}

// ── 렌더링
function renderResults({ pdfList, excelList, result: r, excelWarn }) {
  // PDF 탭
  $("tab-pdf").innerHTML =
    `<div class="section-head">PDF 추출 성분 (${pdfList.length}개)</div>` +
    pdfList.map((ing, i) => ingLine(i + 1, ing)).join("");

  // 엑셀 탭
  $("tab-excel").innerHTML =
    `<div class="section-head">엑셀 성분 (${excelList.length}개)</div>` +
    excelList.map((ing, i) => ingLine(i + 1, ing)).join("");

  // 결과 탭
  let html = "";
  if (excelWarn) html += `<div class="warn-box">${escapeHtml(excelWarn)}</div>`;

  html += `<div class="summary-box"><h2>분석 결과 요약</h2>
    ${summaryRow("PDF 성분 수", r.pdfCount + "개")}
    ${summaryRow("엑셀 성분 수", r.excelCount + "개")}
    ${summaryRow("발견된 문제", r.issueCount + "건")}
    ${r.hasExcel ? summaryRow("성분 순서", r.orderMatched ? "✅ 일치" : "⚠️ 불일치") : ""}
  </div>`;

  if (r.issueCount === 0) {
    html += `<div class="section-head ok">✅ 오탈자나 불일치가 발견되지 않았습니다!</div>`;
  }

  // 오탈자
  if (r.typos.length) {
    html += `<div class="section-head warn">⚠️ 오탈자 의심 (${r.typos.length}건)</div>`;
    for (const t of r.typos) {
      const d = diffMarkup(t.pdf, t.excel);
      html += `<div class="typo-card">
        <div class="row"><span class="k">PDF</span><span>${d.pdfHtml}</span></div>
        <div class="row"><span class="k">엑셀</span><span>${d.exHtml}</span></div>
        <div class="row"><span class="k">유사도</span><span>${Math.round(t.ratio * 100)}%</span></div>
      </div>`;
    }
  }

  // 순서 불일치
  if (r.hasExcel && !r.orderMatched && r.orderMismatchIdx >= 0) {
    const idx = r.orderMismatchIdx;
    html += `<div class="section-head warn">⚠️ 순서 불일치 (${idx + 1}번째부터)</div>`;
    html += `<div class="typo-card">
      <div class="row"><span class="k">위치</span><span>${idx + 1}번째 성분</span></div>
      <div class="row"><span class="k">PDF</span><span>${escapeHtml(pdfList[idx] ?? "(없음)")}</span></div>
      <div class="row"><span class="k">엑셀</span><span>${escapeHtml(excelList[idx] ?? "(없음)")}</span></div>
    </div>`;
  } else if (r.hasExcel && !r.orderMatched) {
    html += `<div class="section-head warn">⚠️ 순서/개수 불일치 (성분 개수가 다릅니다)</div>`;
  }

  // PDF에만
  if (r.only_pdf.length) {
    html += `<div class="section-head err">❌ PDF에만 있는 성분 (${r.only_pdf.length}건)</div>`;
    html += r.only_pdf.map((ing) => `<div class="list-item">${escapeHtml(ing)}</div>`).join("");
  }
  // 엑셀에만
  if (r.only_excel.length) {
    html += `<div class="section-head err">❌ 엑셀에만 있는 성분 (${r.only_excel.length}건)</div>`;
    html += r.only_excel.map((ing) => `<div class="list-item">${escapeHtml(ing)}</div>`).join("");
  }
  // 일치
  if (r.exact.length) {
    html += `<div class="section-head ok">✅ 일치하는 성분 (${r.exact.length}건)</div>`;
    html += r.exact.map((ing) => `<div class="list-item">${escapeHtml(ing)}</div>`).join("");
  }

  $("tab-result").innerHTML = html;
}

function ingLine(idx, ing) {
  return `<div class="ing-line"><span class="idx">${idx}.</span><span>${escapeHtml(ing)}</span></div>`;
}
function summaryRow(label, val) {
  return `<div class="summary-row"><span class="label">${label}</span><span>${escapeHtml(val)}</span></div>`;
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
