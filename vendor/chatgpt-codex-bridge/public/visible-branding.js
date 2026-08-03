export function maskVisibleBrandName(input = "") {
  return String(input ?? "").replace(/chatgpt|gpt/gi, "G某T");
}

const VISIBLE_ATTRIBUTES = ["alt", "aria-label", "placeholder", "title"];
const SKIPPED_TEXT_PARENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);

function maskElementAttributes(element) {
  for (const attribute of VISIBLE_ATTRIBUTES) {
    if (!element.hasAttribute?.(attribute)) continue;
    const current = element.getAttribute(attribute);
    const masked = maskVisibleBrandName(current);
    if (masked !== current) element.setAttribute(attribute, masked);
  }
}

function maskTextNode(node) {
  if (SKIPPED_TEXT_PARENTS.has(node.parentElement?.tagName)) return;
  const current = node.nodeValue || "";
  const masked = maskVisibleBrandName(current);
  if (masked !== current) node.nodeValue = masked;
}

function maskVisibleSubtree(root, windowRef) {
  if (!root) return;
  if (root.nodeType === windowRef.Node.TEXT_NODE) {
    maskTextNode(root);
    return;
  }
  if (root.nodeType === windowRef.Node.ELEMENT_NODE) {
    maskElementAttributes(root);
  }
  const walker = root.ownerDocument?.createTreeWalker(
    root,
    windowRef.NodeFilter.SHOW_ELEMENT | windowRef.NodeFilter.SHOW_TEXT,
  );
  if (!walker) return;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === windowRef.Node.TEXT_NODE) maskTextNode(node);
    else maskElementAttributes(node);
  }
}

export function installVisibleBrandingGuard(documentRef = globalThis.document) {
  const windowRef = documentRef?.defaultView || globalThis;
  if (!documentRef?.documentElement || !windowRef.MutationObserver) return null;

  maskVisibleSubtree(documentRef.documentElement, windowRef);
  const observer = new windowRef.MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        maskElementAttributes(mutation.target);
        continue;
      }
      if (mutation.type === "characterData") {
        maskTextNode(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        maskVisibleSubtree(node, windowRef);
      }
    }
  });
  observer.observe(documentRef.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: VISIBLE_ATTRIBUTES,
  });
  return observer;
}
