const CANONICAL_SITE_URL = "https://ondevotoagora.com.br/";
const SHARE_TITLE = "OndeVotoAgora";
const SHARE_TEXT = "Consulte se sua seção mudou de local para o 2º turno.";

const status = document.querySelector("[data-share-status]");
const copyButton = document.querySelector("[data-copy-site-link]");
const copyLinkIcon = document.querySelector("[data-copy-link-icon]");
const copyConfirmation = document.querySelector("[data-copy-confirmation]");
const nativeShareButton = document.querySelector("[data-share-native]");
const toggleShareButton = document.querySelector("[data-toggle-share]");
const shareOptions = document.querySelector("[data-share-options]");

toggleShareButton?.addEventListener("click", () => {
  const isExpanded = toggleShareButton.getAttribute("aria-expanded") === "true";
  toggleShareButton.setAttribute("aria-expanded", String(!isExpanded));
  shareOptions.hidden = isExpanded;
});

async function copyCanonicalUrl() {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(CANONICAL_SITE_URL);
      return true;
    } catch {
      // Fall through to the legacy copy path when clipboard permission is unavailable.
    }
  }

  const field = document.createElement("textarea");
  field.value = CANONICAL_SITE_URL;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  field.setSelectionRange(0, field.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

async function handleCopy() {
  clearShareFeedback();
  const copied = await copyCanonicalUrl();
  if (copied) {
    showCopyConfirmation("Link copiado.");
    return;
  }
  showVisibleStatus(`Não foi possível copiar automaticamente. Copie este endereço: ${CANONICAL_SITE_URL}`);
}

async function handleNativeShare() {
  clearShareFeedback();
  if (typeof navigator.share !== "function") {
    const copied = await copyCanonicalUrl();
    if (copied) {
      showCopyConfirmation("Menu de compartilhamento indisponível. O link do site foi copiado.");
      return;
    }
    showVisibleStatus(`Menu indisponível. Copie este endereço: ${CANONICAL_SITE_URL}`);
    return;
  }

  try {
    await navigator.share({
      title: SHARE_TITLE,
      text: SHARE_TEXT,
      url: CANONICAL_SITE_URL,
    });
    clearShareFeedback();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    const copied = await copyCanonicalUrl();
    if (copied) {
      showCopyConfirmation("Não foi possível abrir o menu. O link do site foi copiado.");
      return;
    }
    showVisibleStatus(`Não foi possível abrir o menu. Copie este endereço: ${CANONICAL_SITE_URL}`);
  }
}

function clearShareFeedback() {
  copyConfirmation.classList.remove("is-visible");
  copyLinkIcon.classList.remove("is-hidden");
  status.textContent = "";
  status.classList.add("visually-hidden");
}

function showCopyConfirmation(message) {
  copyLinkIcon.classList.add("is-hidden");
  copyConfirmation.classList.add("is-visible");
  status.textContent = message;
  status.classList.add("visually-hidden");
}

function showVisibleStatus(message) {
  copyConfirmation.classList.remove("is-visible");
  copyLinkIcon.classList.remove("is-hidden");
  status.textContent = message;
  status.classList.remove("visually-hidden");
}

copyButton?.addEventListener("click", handleCopy);
nativeShareButton?.addEventListener("click", handleNativeShare);
