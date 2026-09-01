/* Acceptance report interactivity — dependency-free web components.
 * <img-compare>: before/after slider. Attributes: before, after, before-label, after-label.
 * Lightbox + status filter chips. No framework, no build step. */

class ImgCompare extends HTMLElement {
  static observedAttributes = ["before", "after", "before-label", "after-label"];

  connectedCallback() {
    if (this.shadowRoot) return;
    // Light DOM so the report stylesheet applies; build once.
    this.setAttribute("tabindex", "0");
    this.setAttribute("role", "slider");
    this.setAttribute("aria-label", "前后对比");
    this.innerHTML = `
      <img class="before-img" alt="${this.beforeLabel()}">
      <img class="after-img" alt="${this.afterLabel()}">
      <span class="divider"></span>
      <span class="handle">◂▸</span>
      <span class="tag before">${this.beforeLabel()}</span>
      <span class="tag after">${this.afterLabel()}</span>`;
    this.sync();
    this.position = 50;

    this.addEventListener("pointerdown", (event) => {
      this.setPointerCapture(event.pointerId);
      this.moveTo(event);
      const move = (e) => this.moveTo(e);
      const up = () => {
        this.removeEventListener("pointermove", move);
        this.removeEventListener("pointerup", up);
      };
      this.addEventListener("pointermove", move);
      this.addEventListener("pointerup", up);
    });

    this.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.position += event.key === "ArrowLeft" ? -4 : 4;
    });
  }

  beforeLabel() {
    return this.getAttribute("before-label") ?? "修改前";
  }

  afterLabel() {
    return this.getAttribute("after-label") ?? "修改后";
  }

  sync() {
    this.querySelector(".before-img").src = this.getAttribute("before") ?? "";
    this.querySelector(".after-img").src = this.getAttribute("after") ?? "";
  }

  attributeChangedCallback() {
    if (this.querySelector(".before-img")) this.sync();
  }

  moveTo(event) {
    const rect = this.getBoundingClientRect();
    this.position = ((event.clientX - rect.left) / rect.width) * 100;
  }

  set position(value) {
    const clamped = Math.max(0, Math.min(100, value));
    this.style.setProperty("--pos", `${clamped}%`);
    this.setAttribute("aria-valuenow", String(Math.round(clamped)));
  }

  get position() {
    return Number.parseFloat(this.style.getPropertyValue("--pos")) || 50;
  }
}

if (!customElements.get("img-compare")) {
  customElements.define("img-compare", ImgCompare);
}

/* ---------- lightbox ---------- */

const lightbox = document.querySelector(".lightbox");
const stage = lightbox.querySelector(".lightbox-stage");
const caption = lightbox.querySelector(".lightbox-caption");
const counter = lightbox.querySelector(".lightbox-counter");

const items = [...document.querySelectorAll("[data-lightbox]")];
let current = 0;

function renderLightbox() {
  const item = items[current];
  const kind = item.dataset.lightbox;
  stage.querySelector("img, img-compare")?.remove();
  let node;
  if (kind === "compare") {
    node = document.createElement("img-compare");
    node.setAttribute("before", item.dataset.before);
    node.setAttribute("after", item.dataset.after);
    node.setAttribute("before-label", item.dataset.beforeLabel ?? "修改前");
    node.setAttribute("after-label", item.dataset.afterLabel ?? "修改后");
  } else {
    node = document.createElement("img");
    node.src = item.dataset.src;
    node.alt = item.dataset.caption ?? "";
  }
  stage.prepend(node);
  caption.textContent = item.dataset.caption ?? "";
  counter.textContent = `${current + 1} / ${items.length}`;
  const single = items.length < 2;
  lightbox.querySelector(".prev").hidden = single;
  lightbox.querySelector(".next").hidden = single;
}

function openLightbox(index) {
  current = index;
  lightbox.hidden = false;
  requestAnimationFrame(() => lightbox.classList.add("open"));
  renderLightbox();
  lightbox.querySelector(".lightbox-close").focus();
}

function closeLightbox() {
  lightbox.classList.remove("open");
  setTimeout(() => {
    lightbox.hidden = true;
  }, 180);
}

function stepLightbox(delta) {
  current = (current + delta + items.length) % items.length;
  renderLightbox();
}

items.forEach((item, index) => {
  item.addEventListener("click", (event) => {
    // Dragging a compare slider should not pop the lightbox.
    if (item.dataset.lightbox === "compare" && event.target.closest("img-compare")) {
      const cmp = event.target.closest("img-compare");
      if (Math.abs(cmp.position - cmp.dataset.openPos) > 1) return;
    }
    openLightbox(index);
  });
  if (item.dataset.lightbox === "compare") {
    item.addEventListener("pointerdown", () => {
      const cmp = item.querySelector("img-compare");
      cmp.dataset.openPos = cmp.position;
    });
  }
});

lightbox.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
lightbox.querySelector(".prev").addEventListener("click", () => stepLightbox(-1));
lightbox.querySelector(".next").addEventListener("click", () => stepLightbox(1));
lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox || event.target === stage) closeLightbox();
});
document.addEventListener("keydown", (event) => {
  if (lightbox.hidden) return;
  if (event.key === "Escape") closeLightbox();
  if (event.key === "ArrowLeft") stepLightbox(-1);
  if (event.key === "ArrowRight") stepLightbox(1);
});

/* ---------- status filter chips ---------- */

const chips = [...document.querySelectorAll(".chip[data-filter]")];
const cases = [...document.querySelectorAll(".case[data-final]")];

chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const filter = chip.dataset.filter;
    chips.forEach((c) => {
      c.setAttribute("aria-pressed", String(c === chip));
    });
    for (const panel of cases) {
      panel.hidden = filter !== "ALL" && panel.dataset.final !== filter;
    }
  });
});
