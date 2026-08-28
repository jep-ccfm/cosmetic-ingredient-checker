// 화장품 패키지 문안 검수기 — 프론트엔드
// 기준 문안(정답) ↔ 디자인(검수 대상)를 내용 기준으로 대조하고,
// 디자인 이미지 위에 문제 지점을 형광펜으로 표시.
// 입력: 파일(PDF·이미지) 또는 링크(구글 시트/드라이브/일반 URL).

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

const MAX_EDGE = 2200; // 고해상도 판독 (긴 변 기준 px)

let refFile = null;
let targetFile = null;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const analyzeBtn = $("analyze-btn");

$("ref-input").addEventListener("change", (e) => { refFile = e.target.files[0] || null; setFileName("ref-name", refFile); });
$("target-input").addEventListener("change", (e) => { targetFile = e.target.files[0] || null; setFileName("target-name", targetFile); });

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
  const refUrl = $("ref-url").value.trim();
  const targetUrl = $("target-url").value.trim();
  if (!refFile && !refUrl) return alert("① 기준 문안: 파일 또는 링크를 넣어주세요.");
  if (!targetFile && !targetUrl) return alert("② 디자인: 파일 또는 링크를 넣어주세요.");

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "검수 중...";
  try {
    setStatus("기준 문안을 불러오는 중...");
    const ref = await loadSide(refFile, refUrl, "reference");
    setStatus("디자인을 불러오는 중...");
    const target = await loadSide(targetFile, targetUrl, "target");

    if (!target.pages || !target.pages.length) {
      throw new Error("디자인은 PDF 또는 이미지여야 합니다 (텍스트 링크는 디자인으로 쓸 수 없어요).");
    }

    setStatus("두 문서를 대조 검수하는 중... (AI 판독, 최대 1분 소요될 수 있어요)");
    const referencePayload = ref.text
      ? { text: ref.text }
      : { images: ref.pages.map((p) => p.b64) };

    const res = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: referencePayload,
        target: { images: target.pages.map((p) => p.b64) },
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
        `<div class="warn-box">결과 JSON 파싱 실패. 원문 응답:</div><pre class="rawtext">${escapeHtml(json.raw || "")}</pre>`;
      activateTab("result");
      setStatus("결과 형식 오류 — 원문을 확인하세요.");
      return;
    }

    const data = json.data;
    renderResult(data, target.pages);
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

function activateTab(name) { document.querySelector(`.tab[data-tab="${name}"]`).click(); }

// 한 쪽 입력을 로드 → { text } (문안 텍스트) 또는 { pages: [{b64, dataUrl}] }
// URL이 있으면 URL 우선.
async function loadSide(file, url, which) {
  if (url) {
    const r = await fetch("/api/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) {
      let d = ""; try { d = (await r.json()).error || ""; } catch (_) {}
      throw new Error(`링크 불러오기 실패 (${r.status}) ${d}`);
    }
    const j = await r.json();
    if (j.kind === "text") {
      if (which === "target") throw new Error("디자인 링크는 PDF/이미지 파일이어야 합니다.");
      return { text: j.text };
    }
    if (j.kind === "pdf") return { pages: await pdfToJpegPages(base64ToBytes(j.b64)) };
    if (j.kind === "image") return { pages: [await imageToJpegPage(`data:${j.mediaType};base64,${j.b64}`)] };
    throw new Error("링크에서 지원하는 콘텐츠를 찾지 못했습니다.");
  }

  // 파일
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    return { pages: await pdfToJpegPages(await file.arrayBuffer()) };
  }
  if (file.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(file.name)) {
    return { pages: [await imageToJpegPage(await fileToDataUrl(file))] };
  }
  throw new Error(`지원하지 않는 파일 형식입니다: ${file.name} (PDF·이미지만)`);
}

// PDF(ArrayBuffer/Uint8Array) → 페이지별 JPEG
async function pdfToJpegPages(data) {
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(1, Math.min(3, MAX_EDGE / Math.max(base.width, base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    pages.push(canvasToPage(canvas));
  }
  return pages;
}

// 이미지 dataURL → JPEG 페이지 (긴 변 MAX_EDGE로 축소)
function imageToJpegPage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvasToPage(canvas));
    };
    img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    img.src = dataUrl;
  });
}

function canvasToPage(canvas) {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { b64: dataUrl.split(",")[1], dataUrl };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    fr.readAsDataURL(file);
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

const CAT_CLASS = { "오탈자": "warn", "미기재": "err", "오기재": "err", "기타": "dim" };

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
      html += `<div class="hl ${CAT_CLASS[f.category] || "warn"}" style="left:${L}%;top:${T}%;width:${W}%;height:${H}%"><span class="hl-badge">${no}</span></div>`;
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
  $(tabId).innerHTML = `<div class="section-head">${title}</div><pre class="rawtext">${escapeHtml(text || "(없음)")}</pre>`;
}

function clamp(v) { return Math.max(0, Math.min(1, v)); }
function summaryRow(label, val) { return `<div class="summary-row"><span class="label">${label}</span><span>${escapeHtml(val)}</span></div>`; }
function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
