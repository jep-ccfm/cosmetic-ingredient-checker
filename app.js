// 화장품 패키지 문안 검수기 — 프론트엔드
// 기준 문안 PDF(정답) ↔ 디자인 PDF(검수 대상)를 Claude가 내용 기준으로 대조.
// 문제 지점을 디자인 이미지 위에 형광펜(하이라이트)으로 표시.

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

const MAX_EDGE = 2400; // 고해상도 판독 (긴 변 기준 px)

let refFile = null;
let targetFile = null;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const analyzeBtn = $("analyze-btn");

$("ref-input").addEventListener("change", (e) => {
  refFile = e.target.files[0] || null;
  setFileName("ref-name", refFile);
});
$("target-input").addEventListener("change", (e) => {
  targetFile = e.target.files[0] || null;
  setFileName("target-name", targetFile);
});

function setFileName(id, file) {
  const el = $(id);
  el.textContent = file ? file.name : "선택된 파일 없음";
  el.classList.toggle("set", !!file);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("tab-" + tab.dataset.tab).classList.add("active");
  });
});

const setStatus = (m) => (statusEl.textContent = m);

analyzeBtn.addEventListener("click", runAnalysis);

async function runAnalysis() {
  if (!refFile) return alert("기준 문안 PDF를 선택해주세요.");
  if (!targetFile) return alert("디자인 PDF를 선택해주세요.");

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "검수 중...";
  try {
    setStatus("PDF를 고해상도 이미지로 변환하는 중...");
    const refPages = await pdfToImages(refFile);
    const targetPages = await pdfToImages(targetFile);

    setStatus("두 문서를 대조 검수하는 중... (AI 판독, 20~40초 소요될 수 있어요)");
    const res = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: refPages.map((p) => p.b64),
        target: targetPages.map((p) => p.b64),
        mediaType: "image/jpeg",
      }),
    });

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch (_) {}
      throw new Error(`검수 실패 (${res.status}) ${detail}`);
    }

    const json = await res.json();
    if (json.parseError) {
      $("tab-result").innerHTML =
        `<div class="warn-box">결과 JSON 파싱에 실패했습니다. 원문 응답:</div>` +
        `<pre>${escapeHtml(json.raw || "")}</pre>`;
      activateTab("result");
      setStatus("결과 형식 오류 — 원문을 확인하세요.");
      return;
    }

    const data = json.data;
    renderResult(data, targetPages);
    renderText("tab-ref", "기준 문안 텍스트", data.reference_text);
    renderText("tab-target", "디자인 텍스트", data.target_text);
    activateTab("result");

    const n = (data.findings || []).length;
    setStatus(n === 0 ? "검수 완료 — 문제가 발견되지 않았습니다." : `검수 완료 — 문제 ${n}건 발견`);
  } catch (err) {
    console.error(err);
    $("tab-result").innerHTML = `<div class="err-box">검수 중 오류: ${escapeHtml(err.message || String(err))}</div>`;
    activateTab("result");
    setStatus("오류가 발생했습니다.");
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "검수 시작";
  }
}

function activateTab(name) {
  document.querySelector(`.tab[data-tab="${name}"]`).click();
}

// ── PDF → 페이지별 {b64, w, h, dataUrl}
async function pdfToImages(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    // pdf.js는 페이지의 /Rotate 속성을 자동 반영 → 페이지 단위 회전은 자동 보정
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(1, Math.min(3, MAX_EDGE / Math.max(base.width, base.height)));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    pages.push({ b64: dataUrl.split(",")[1], dataUrl, w: canvas.width, h: canvas.height });
  }
  return pages;
}

const CAT_CLASS = { "오탈자": "warn", "미기재": "err", "오기재": "err", "기타": "dim" };

// ── 결과 렌더 (요약 + 하이라이트 이미지 + 문제 목록)
function renderResult(data, targetPages) {
  const findings = data.findings || [];
  const el = $("tab-result");

  const counts = { "오탈자": 0, "미기재": 0, "오기재": 0, "기타": 0 };
  findings.forEach((f) => { counts[f.category] = (counts[f.category] || 0) + 1; });

  let html = `<div class="summary-box"><h2>검수 결과 요약</h2>
    ${summaryRow("총 문제", findings.length + "건")}
    ${summaryRow("· 오탈자", counts["오탈자"] + "건")}
    ${summaryRow("· 미기재", counts["미기재"] + "건")}
    ${summaryRow("· 오기재", counts["오기재"] + "건")}
    ${counts["기타"] ? summaryRow("· 기타", counts["기타"] + "건") : ""}
  </div>`;

  if (data.notes) html += `<div class="warn-box">📌 판독 특이사항: ${escapeHtml(data.notes)}</div>`;

  if (findings.length === 0) {
    html += `<div class="section-head ok">✅ 디자인에서 문제가 발견되지 않았습니다.</div>`;
    el.innerHTML = html;
    return;
  }

  html += `<div class="section-head">🖍️ 문제 위치 (디자인)</div>`;
  html += `<p class="mini-hint">번호를 아래 목록과 대조하세요. 좌표는 AI 추정치라 실제 위치와 약간 다를 수 있습니다.</p>`;

  targetPages.forEach((pg, pi) => {
    const pageNo = pi + 1;
    const onPage = findings
      .map((f, idx) => ({ f, no: idx + 1 }))
      .filter((x) => x.f.page === pageNo && Array.isArray(x.f.box) && x.f.box.length === 4);

    html += `<div class="page-wrap"><img src="${pg.dataUrl}" alt="디자인 ${pageNo}페이지" />`;
    onPage.forEach(({ f, no }) => {
      const [x0, y0, x1, y1] = f.box;
      const L = clamp(Math.min(x0, x1)) * 100;
      const T = clamp(Math.min(y0, y1)) * 100;
      const W = Math.abs(x1 - x0) * 100;
      const H = Math.abs(y1 - y0) * 100;
      html += `<div class="hl ${CAT_CLASS[f.category] || "warn"}" style="left:${L}%;top:${T}%;width:${W}%;height:${H}%">
        <span class="hl-badge">${no}</span></div>`;
    });
    html += `</div>`;
  });

  html += `<div class="section-head">📋 문제 상세</div>`;
  findings.forEach((f, idx) => {
    const cls = CAT_CLASS[f.category] || "dim";
    const noBox = !(Array.isArray(f.box) && f.box.length === 4 && f.page);
    html += `<div class="finding ${cls}">
      <div class="finding-head"><span class="no">${idx + 1}</span>
        <span class="cat ${cls}">${escapeHtml(f.category || "")}</span>
        <span class="loc">${escapeHtml(f.location || "")}</span>
        ${noBox ? '<span class="noloc">위치 표시 없음</span>' : `<span class="pageno">${f.page}p</span>`}
      </div>
      <div class="finding-body">
        <div class="row"><span class="k">정답(문안)</span><span>${escapeHtml(f.reference || "-")}</span></div>
        <div class="row"><span class="k">디자인</span><span>${escapeHtml(f.target || "-")}</span></div>
        <div class="row"><span class="k">설명</span><span>${escapeHtml(f.detail || "")}</span></div>
      </div>
    </div>`;
  });

  el.innerHTML = html;
}

function renderText(tabId, title, text) {
  $(tabId).innerHTML =
    `<div class="section-head">${title}</div><pre class="rawtext">${escapeHtml(text || "(없음)")}</pre>`;
}

function clamp(v) { return Math.max(0, Math.min(1, v)); }
function summaryRow(label, val) {
  return `<div class="summary-row"><span class="label">${label}</span><span>${escapeHtml(val)}</span></div>`;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
