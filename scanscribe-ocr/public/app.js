import { createWorker } from "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm";
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.mjs";

const state = {
  file: null,
  pages: [],
  isProcessing: false
};

const refs = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  extractButton: document.getElementById("extractButton"),
  clearButton: document.getElementById("clearButton"),
  copyButton: document.getElementById("copyButton"),
  downloadButton: document.getElementById("downloadButton"),
  fileBadge: document.getElementById("fileBadge"),
  pageCount: document.getElementById("pageCount"),
  statusTitle: document.getElementById("statusTitle"),
  statusText: document.getElementById("statusText"),
  progressBar: document.getElementById("progressBar"),
  progressLabel: document.getElementById("progressLabel"),
  previewGrid: document.getElementById("previewGrid"),
  resultText: document.getElementById("resultText"),
  languageSelect: document.getElementById("languageSelect"),
  documentTitle: document.getElementById("documentTitle"),
  toastStack: document.getElementById("toastStack")
};

function showToast(message, type = "") {
  const toast = document.createElement("div");
  toast.className = `toast ${type ? `toast--${type}` : ""}`.trim();
  toast.textContent = message;
  refs.toastStack.append(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 4000);
}

function setStatus(title, text) {
  refs.statusTitle.textContent = title;
  refs.statusText.textContent = text;
}

function setProgress(value) {
  const normalized = Math.max(0, Math.min(100, Math.round(value)));
  refs.progressBar.style.width = `${normalized}%`;
  refs.progressLabel.textContent = `${normalized}%`;
}

function slugifyFilename(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "scanned-document";
}

function updateControls() {
  const hasPages = state.pages.length > 0;
  const hasText = refs.resultText.value.trim().length > 0;

  refs.extractButton.disabled = !hasPages || state.isProcessing;
  refs.clearButton.disabled = !state.file || state.isProcessing;
  refs.copyButton.disabled = !hasText || state.isProcessing;
  refs.downloadButton.disabled = !hasText || state.isProcessing;
  refs.fileInput.disabled = state.isProcessing;
}

function resetResults() {
  refs.resultText.value = "";
  setProgress(0);
}

function renderEmptyPreview() {
  refs.previewGrid.replaceChildren();

  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.innerHTML =
    "<strong>Your document preview will appear here.</strong><span>PDFs are split into pages automatically before OCR starts.</span>";

  refs.previewGrid.append(empty);
}

function renderPreviews() {
  refs.previewGrid.replaceChildren();

  state.pages.forEach((page) => {
    const card = document.createElement("article");
    card.className = "preview-card";

    const label = document.createElement("div");
    label.className = "preview-card__label";
    label.textContent = `Page ${page.index}`;

    const image = document.createElement("img");
    image.className = "preview-card__image";
    image.src = page.dataUrl;
    image.alt = `Preview for page ${page.index}`;

    card.append(label, image);
    refs.previewGrid.append(card);
  });
}

function syncMetadata() {
  refs.fileBadge.textContent = state.file ? state.file.name : "No file selected";
  refs.pageCount.textContent = `${state.pages.length} ${state.pages.length === 1 ? "page" : "pages"}`;
}

function clearDocument() {
  state.file = null;
  state.pages = [];
  state.isProcessing = false;
  refs.fileInput.value = "";
  refs.documentTitle.value = "scanned-document";
  syncMetadata();
  renderEmptyPreview();
  resetResults();
  setStatus("Ready", "Upload a scan to start OCR.");
  updateControls();
}

async function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("Could not convert canvas to blob."));
    }, "image/png");
  });
}

async function renderPdfPages(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });

    if (!context) {
      throw new Error("Canvas rendering is not available in this browser.");
    }

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    await page.render({
      canvasContext: context,
      viewport
    }).promise;

    const blob = await canvasToBlob(canvas);
    const dataUrl = canvas.toDataURL("image/png");

    pages.push({
      index: pageNumber,
      blob,
      dataUrl
    });
  }

  return pages;
}

async function createImagePage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });

  return [
    {
      index: 1,
      blob: file,
      dataUrl
    }
  ];
}

async function loadDocument(file) {
  const normalizedName = slugifyFilename(file.name.replace(/\.[^/.]+$/, ""));

  state.file = file;
  state.pages = [];
  resetResults();
  refs.documentTitle.value = normalizedName;
  syncMetadata();
  updateControls();

  setStatus("Preparing document", "Loading preview pages for OCR.");

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  state.pages = isPdf ? await renderPdfPages(file) : await createImagePage(file);

  syncMetadata();
  renderPreviews();
  setStatus("Document ready", "Preview generated. Start OCR when you are ready.");
  updateControls();
}

async function handleSelectedFile(file) {
  if (!file) {
    return;
  }

  const acceptedTypes = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
  const lowerName = file.name.toLowerCase();
  const acceptedExtension =
    lowerName.endsWith(".pdf") ||
    lowerName.endsWith(".png") ||
    lowerName.endsWith(".jpg") ||
    lowerName.endsWith(".jpeg") ||
    lowerName.endsWith(".webp");

  if (!acceptedTypes.includes(file.type) && !acceptedExtension) {
    showToast("Please upload a PDF, PNG, JPG, or WebP file.", "error");
    return;
  }

  try {
    await loadDocument(file);
  } catch (error) {
    clearDocument();
    showToast(error instanceof Error ? error.message : "Document loading failed.", "error");
  }
}

async function extractText() {
  if (!state.pages.length || state.isProcessing) {
    return;
  }

  const language = refs.languageSelect.value;
  const segments = [];
  let activePageIndex = 0;

  state.isProcessing = true;
  updateControls();
  setStatus("Running OCR", "Recognition has started. Keep this tab open.");
  setProgress(1);

  const worker = await createWorker(language, 1, {
    logger: (message) => {
      if (message.status === "recognizing text") {
        const totalProgress =
          ((activePageIndex + message.progress) / state.pages.length) * 100;
        setProgress(totalProgress);
      }
    }
  });

  try {
    for (let index = 0; index < state.pages.length; index += 1) {
      const page = state.pages[index];
      activePageIndex = index;
      setStatus(
        "Running OCR",
        `Extracting text from page ${page.index} of ${state.pages.length}.`
      );

      const {
        data: { text }
      } = await worker.recognize(page.blob);

      const cleaned = text.trim();
      segments.push(
        state.pages.length > 1 ? `Page ${page.index}\n${cleaned}`.trim() : cleaned
      );

      const completed = ((index + 1) / state.pages.length) * 100;
      setProgress(completed);
    }

    refs.resultText.value = segments.join("\n\n");
    setStatus("OCR complete", "Your document text is ready to copy or download.");
    showToast("OCR finished successfully.");
  } catch (error) {
    setStatus("OCR failed", "The file could not be processed. Try a clearer scan or a smaller PDF.");
    showToast(error instanceof Error ? error.message : "OCR failed.", "error");
  } finally {
    await worker.terminate();
    state.isProcessing = false;
    updateControls();
  }
}

async function copyText() {
  try {
    await navigator.clipboard.writeText(refs.resultText.value);
    showToast("Extracted text copied to the clipboard.");
  } catch {
    showToast("Clipboard access failed. Copy the text manually.", "error");
  }
}

function downloadText() {
  const content = refs.resultText.value;
  const filename = `${slugifyFilename(refs.documentTitle.value)}.txt`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

refs.fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files ?? [];
  void handleSelectedFile(file);
});

refs.extractButton.addEventListener("click", () => {
  void extractText();
});

refs.clearButton.addEventListener("click", () => {
  clearDocument();
});

refs.copyButton.addEventListener("click", () => {
  void copyText();
});

refs.downloadButton.addEventListener("click", () => {
  downloadText();
});

refs.dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  refs.dropzone.classList.add("dropzone--active");
});

refs.dropzone.addEventListener("dragleave", () => {
  refs.dropzone.classList.remove("dropzone--active");
});

refs.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  refs.dropzone.classList.remove("dropzone--active");
  const [file] = event.dataTransfer?.files ?? [];
  void handleSelectedFile(file);
});

renderEmptyPreview();
syncMetadata();
setProgress(0);
updateControls();
